import { createHash } from "node:crypto";
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
import {
  isMaxCompletionTokensUnsupported,
  isTemperatureUnsupported,
  wantsMaxCompletionTokens,
} from "./param-support.js";
import { fetchWithTimeout, sendWithRateLimitRetry } from "./retry.js";

export interface OpenAiProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /**
   * Opt into prompt caching parity with the Anthropic/Bedrock providers
   * (default on). OpenAI-compatible APIs cache automatically once the prompt
   * prefix is stable, but route by `prompt_cache_key` — without one, an agent's
   * long, stable system+tools prefix is re-billed in full every turn, which is
   * how a non-Anthropic run burned millions of input tokens across a handful of
   * calls. We send a key derived from that prefix so every turn of a run lands
   * on the same cache.
   */
  promptCache?: boolean;
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
 * The token-budget parameter and `temperature` are flexed on the API's error:
 * newer reasoning models require `max_completion_tokens` and reject
 * `temperature`, while older models take `max_tokens` — we retry rather than
 * track model names.
 */
export function createOpenAiProvider(config: OpenAiProviderConfig): ProviderAdapter {
  const baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const promptCache = config.promptCache ?? true;

  return {
    name: "openai",
    model: config.model,
    async requestTurn(input: ProviderTurnInput): Promise<ProviderTurnResult> {
      const messages: JsonObject[] = [{ role: "system", content: input.system }];
      for (const message of input.messages) {
        messages.push(...toOpenAiMessages(message));
      }
      const toolDefs = input.tools.map(toOpenAiTool);
      // Route every turn that shares this run's stable prefix (system prompt +
      // tool catalog) to the same prompt cache. The conversation grows each
      // turn, but the prefix the cache keys on does not, so the bulk of the
      // prompt bills at the cached rate after turn 1 — the OpenAI-compatible
      // analogue of the Anthropic cache_control breakpoint.
      const promptCacheKey = promptCache ? cachePrefixKey(input.system, toolDefs) : undefined;

      // Reasoning models want `max_completion_tokens` and reject `temperature`;
      // older models take `max_tokens`. Start with the modern shape, then flex
      // on whichever parameter the API rejects (up to two retries).
      let tokenParam: "max_completion_tokens" | "max_tokens" = "max_completion_tokens";
      let includeTemperature = typeof input.temperature === "number";

      const send = (): Promise<Response> => {
        const body: JsonObject = {
          model: config.model,
          messages,
          [tokenParam]: input.maxTokens,
          tools: toolDefs,
          tool_choice: "auto",
        };
        if (promptCacheKey) body.prompt_cache_key = promptCacheKey;
        if (includeTemperature && typeof input.temperature === "number") {
          body.temperature = input.temperature;
        }
        return fetchWithTimeout(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      };

      let response: Response;
      let text: string;
      try {
        // 429/overload retries happen inside the turn (honouring retry-after)
        // before the param-compatibility retries below — see retry.ts.
        response = await sendWithRateLimitRetry(send);
        text = await response.text();
        for (let attempt = 0; attempt < 2 && !response.ok; attempt++) {
          let changed = false;
          if (includeTemperature && isTemperatureUnsupported(text)) {
            includeTemperature = false;
            changed = true;
          }
          if (tokenParam === "max_tokens" && wantsMaxCompletionTokens(text)) {
            tokenParam = "max_completion_tokens";
            changed = true;
          } else if (
            tokenParam === "max_completion_tokens" &&
            isMaxCompletionTokensUnsupported(text)
          ) {
            tokenParam = "max_tokens";
            changed = true;
          }
          if (!changed) break;
          response = await sendWithRateLimitRetry(send);
          text = await response.text();
        }
      } catch (error) {
        return {
          ok: false,
          code: "network_error",
          message: error instanceof Error ? error.message : String(error),
        };
      }

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
        // OpenAI-compatible APIs report cache hits but count them INSIDE
        // prompt_tokens, so cacheRead here is informational, not additive. There
        // is no explicit cache-write count.
        cacheReadInputTokens: readCachedTokens(usage),
      };
    },
  };
}

// Cached prompt tokens (already included in prompt_tokens). Providers disagree on
// where they report it: OpenAI uses prompt_tokens_details.cached_tokens, DeepSeek
// uses a top-level prompt_cache_hit_tokens. Read both so a cache hit is captured
// regardless of which OpenAI-compatible backend served the call — otherwise a
// DeepSeek run looks 100% uncached and its spend reads far higher than it was.
function readCachedTokens(usage: JsonObject): number {
  const details = usage.prompt_tokens_details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const cached = (details as JsonObject).cached_tokens;
    if (typeof cached === "number") return cached;
  }
  if (typeof usage.prompt_cache_hit_tokens === "number") return usage.prompt_cache_hit_tokens;
  return 0;
}

// A stable cache key for a run's prompt prefix: a short hash of the system prompt
// and the tool catalog (names + parameter schemas). Both are fixed for the whole
// run, so every turn produces the same key and OpenAI routes them to one cache;
// a different agent (different system/tools) gets a different key.
function cachePrefixKey(system: string, tools: JsonObject[]): string {
  const toolSig = tools
    .map((t) => {
      const fn = (t.function ?? {}) as JsonObject;
      return `${typeof fn.name === "string" ? fn.name : ""}:${JSON.stringify(fn.parameters ?? {})}`;
    })
    .join("\n");
  return `anchorage-${createHash("sha256").update(`${system}\n${toolSig}`).digest("hex").slice(0, 32)}`;
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
