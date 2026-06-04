import type {
  AssistantMessage,
  ContentBlock,
  JsonObject,
  JsonValue,
  LoopMessage,
  ProviderAdapter,
  ProviderTurnInput,
  ProviderTurnResult,
  TextBlock,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
  UserMessage,
} from "../types.js";

export interface AnthropicProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  anthropicVersion?: string;
  promptCache?: boolean;
}

/**
 * Build a ProviderAdapter that talks to the Anthropic Messages API. Internal
 * content-block shape mirrors Anthropic's, so message translation is mostly
 * identity — we just normalize the `tool_result.content` field (string vs
 * block array) and read back the response blocks.
 */
export function createAnthropicProvider(config: AnthropicProviderConfig): ProviderAdapter {
  const baseUrl = (config.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
  const anthropicVersion = config.anthropicVersion ?? "2023-06-01";
  const promptCache = config.promptCache ?? true;

  return {
    name: "anthropic",
    model: config.model,
    async requestTurn(input: ProviderTurnInput): Promise<ProviderTurnResult> {
      const body: JsonObject = {
        model: config.model,
        max_tokens: input.maxTokens,
        system: [systemBlock(input.system, promptCache)],
        messages: input.messages.map(toAnthropicMessage),
        tools: input.tools.map(toAnthropicTool),
      };
      if (typeof input.temperature === "number") body.temperature = input.temperature;

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/messages`, {
          method: "POST",
          headers: {
            "anthropic-version": anthropicVersion,
            "content-type": "application/json",
            "x-api-key": config.apiKey,
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

      const rawContent = Array.isArray(parsed.content) ? (parsed.content as JsonValue[]) : [];
      const blocks = rawContent
        .map(toContentBlock)
        .filter((block): block is ContentBlock => block !== null);

      const usage = (parsed.usage ?? {}) as JsonObject;
      return {
        ok: true,
        content: blocks,
        stopReason: typeof parsed.stop_reason === "string" ? parsed.stop_reason : null,
        inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
        outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      };
    },
  };
}

function systemBlock(text: string, promptCache: boolean): JsonObject {
  const block: JsonObject = { type: "text", text };
  if (promptCache) block.cache_control = { type: "ephemeral" };
  return block;
}

function toAnthropicTool(tool: ToolDefinition): JsonObject {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

function toAnthropicMessage(message: LoopMessage): JsonObject {
  if (message.role === "user") {
    return { role: "user", content: toAnthropicUserContent(message) };
  }
  return { role: "assistant", content: message.content.map(toAnthropicBlock) };
}

function toAnthropicUserContent(message: UserMessage): JsonValue {
  if (typeof message.content === "string") return message.content;
  return message.content.map(toAnthropicBlock);
}

function toAnthropicBlock(block: ContentBlock): JsonObject {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "tool_use") {
    return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  }
  // tool_result
  return {
    type: "tool_result",
    tool_use_id: block.tool_use_id,
    content:
      typeof block.content === "string" ? block.content : block.content.map(toAnthropicBlock),
    ...(block.is_error ? { is_error: true } : {}),
  };
}

function toContentBlock(raw: JsonValue): ContentBlock | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as JsonObject;
  const type = obj.type;
  if (type === "text" && typeof obj.text === "string") {
    return { type: "text", text: obj.text } satisfies TextBlock;
  }
  if (type === "tool_use" && typeof obj.id === "string" && typeof obj.name === "string") {
    const input = (obj.input ?? {}) as JsonObject;
    return { type: "tool_use", id: obj.id, name: obj.name, input } satisfies ToolUseBlock;
  }
  if (type === "tool_result" && typeof obj.tool_use_id === "string") {
    const content =
      typeof obj.content === "string"
        ? obj.content
        : Array.isArray(obj.content)
          ? (obj.content as JsonValue[])
              .map(toContentBlock)
              .filter((block): block is ContentBlock => block !== null)
          : "";
    return {
      type: "tool_result",
      tool_use_id: obj.tool_use_id,
      content,
      ...(obj.is_error === true ? { is_error: true } : {}),
    } satisfies ToolResultBlock;
  }
  return null;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

// Re-exports used by callers that want to type-narrow:
export type { AssistantMessage };
