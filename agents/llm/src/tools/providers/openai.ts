import type {
  AssistantMessage,
  ContentBlock,
  JsonObject,
  JsonValue,
  LoopMessage,
  ProviderAdapter,
  ProviderTurnInput,
  ProviderTurnResult,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
} from "../types.js";

export interface OpenAiProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

/**
 * Build a ProviderAdapter that talks to OpenAI's Chat Completions API. The
 * shape differs from Anthropic in three ways:
 *   1. Tools are wrapped as `{ type: "function", function: { ... } }`.
 *   2. Assistant tool calls come back on a separate `tool_calls[]` field on
 *      the message; this adapter normalizes them back into our internal
 *      tool_use blocks.
 *   3. Tool results are flat messages with role "tool" and a `tool_call_id`,
 *      not blocks inside a user message — so a user message with N
 *      tool_result blocks fans out into N tool messages.
 *
 * Also covers Moonshot, Kimi, and any openai-compatible gateway.
 */
export function createOpenAiProvider(config: OpenAiProviderConfig): ProviderAdapter {
  const baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");

  return {
    name: "openai",
    model: config.model,
    async requestTurn(input: ProviderTurnInput): Promise<ProviderTurnResult> {
      const messages: JsonObject[] = [{ role: "system", content: input.system }];
      for (const message of input.messages) {
        messages.push(...toOpenAiMessages(message));
      }

      const body: JsonObject = {
        model: config.model,
        messages,
        max_tokens: input.maxTokens,
        tools: input.tools.map(toOpenAiTool),
        tool_choice: "auto",
      };
      if (typeof input.temperature === "number") body.temperature = input.temperature;

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        return {
          ok: false,
          code: "network_error",
          message: error instanceof Error ? error.message : String(error),
        };
      }

      const text = await response.text();
      if (!response.ok) {
        return {
          ok: false,
          code: `http_${response.status}`,
          message: `${response.status} ${response.statusText}: ${truncate(text, 1000)}`,
        };
      }

      let parsed: JsonObject;
      try {
        parsed = JSON.parse(text) as JsonObject;
      } catch (error) {
        return {
          ok: false,
          code: "invalid_json",
          message: error instanceof Error ? error.message : String(error),
        };
      }

      const choices = Array.isArray(parsed.choices) ? (parsed.choices as JsonObject[]) : [];
      const first = choices[0];
      if (!first || typeof first !== "object") {
        return { ok: false, code: "no_choice", message: "OpenAI response had no choices." };
      }
      const message = (first.message ?? {}) as JsonObject;

      const blocks: ContentBlock[] = [];
      if (typeof message.content === "string" && message.content.length > 0) {
        blocks.push({ type: "text", text: message.content });
      } else if (Array.isArray(message.content)) {
        for (const part of message.content as JsonValue[]) {
          if (typeof part === "object" && part !== null && !Array.isArray(part)) {
            const partObj = part as JsonObject;
            if (typeof partObj.text === "string") {
              blocks.push({ type: "text", text: partObj.text });
            }
          }
        }
      }

      const toolCalls = Array.isArray(message.tool_calls)
        ? (message.tool_calls as JsonObject[])
        : [];
      for (const call of toolCalls) {
        const fn = (call.function ?? {}) as JsonObject;
        const id = typeof call.id === "string" ? call.id : "";
        const name = typeof fn.name === "string" ? fn.name : "";
        const argText = typeof fn.arguments === "string" ? fn.arguments : "{}";
        if (!id || !name) continue;
        let parsedArgs: JsonObject = {};
        try {
          const value = JSON.parse(argText);
          if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            parsedArgs = value as JsonObject;
          }
        } catch {
          // Surface bad JSON to the model as an empty input; the tool handler
          // will respond with an invalid_input error if needed.
        }
        const block: ToolUseBlock = { type: "tool_use", id, name, input: parsedArgs };
        blocks.push(block);
      }

      const usage = (parsed.usage ?? {}) as JsonObject;
      return {
        ok: true,
        content: blocks,
        stopReason: typeof first.finish_reason === "string" ? first.finish_reason : null,
        inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
        outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
      };
    },
  };
}

function toOpenAiTool(tool: ToolDefinition): JsonObject {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function toOpenAiMessages(message: LoopMessage): JsonObject[] {
  if (message.role === "user") {
    return userMessageToOpenAi(message);
  }
  return assistantMessageToOpenAi(message);
}

function userMessageToOpenAi(message: {
  role: "user";
  content: string | ContentBlock[];
}): JsonObject[] {
  if (typeof message.content === "string") {
    return [{ role: "user", content: message.content }];
  }
  // A user message can carry text blocks (treat as combined user text) and
  // tool_result blocks (each becomes a separate `tool` role message).
  const out: JsonObject[] = [];
  const textParts: string[] = [];
  const toolResults: ToolResultBlock[] = [];
  for (const block of message.content) {
    if (block.type === "text") textParts.push(block.text);
    else if (block.type === "tool_result") toolResults.push(block);
  }
  if (textParts.length > 0) {
    out.push({ role: "user", content: textParts.join("\n") });
  }
  for (const result of toolResults) {
    const content =
      typeof result.content === "string" ? result.content : flattenBlocksToString(result.content);
    out.push({
      role: "tool",
      tool_call_id: result.tool_use_id,
      content,
    });
  }
  return out;
}

function assistantMessageToOpenAi(message: AssistantMessage): JsonObject[] {
  const textParts: string[] = [];
  const toolCalls: JsonObject[] = [];
  for (const block of message.content) {
    if (block.type === "text") textParts.push(block.text);
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }
  const out: JsonObject = { role: "assistant" };
  if (textParts.length > 0) out.content = textParts.join("\n");
  else out.content = null; // OpenAI requires `content` to exist even when only tool_calls
  if (toolCalls.length > 0) out.tool_calls = toolCalls;
  return [out];
}

function flattenBlocksToString(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
