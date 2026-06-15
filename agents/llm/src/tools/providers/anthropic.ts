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
import { isTemperatureUnsupported } from "./param-support.js";
import { sendWithRateLimitRetry } from "./retry.js";

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
      const send = (includeTemperature: boolean): Promise<Response> => {
        const body: JsonObject = {
          model: config.model,
          max_tokens: input.maxTokens,
          system: [systemBlock(input.system, promptCache)],
          // Incremental (multi-turn) caching: the breakpoint on the last message
          // writes a cache of the whole conversation prefix each turn, and the
          // next turn reads the longest matching cached prefix — so after turn 1
          // the bulk of the (growing) history is billed at the cached rate. The
          // breakpoint only marks where to WRITE the cache; the model sees the
          // exact same content, so this is lossless.
          messages: withConversationCacheBreakpoint(
            input.messages.map(toAnthropicMessage),
            promptCache,
          ),
          // Tool schemas are large and stable for the whole run; caching them
          // (breakpoint on the last tool) removes them from the per-turn bill.
          tools: withToolCacheBreakpoint(input.tools.map(toAnthropicTool), promptCache),
        };
        if (includeTemperature && typeof input.temperature === "number") {
          body.temperature = input.temperature;
        }
        return fetch(`${baseUrl}/messages`, {
          method: "POST",
          headers: {
            "anthropic-version": anthropicVersion,
            "content-type": "application/json",
            "x-api-key": config.apiKey,
          },
          body: JSON.stringify(body),
        });
      };

      let response: Response;
      try {
        // 429/overload retries happen inside the turn (honouring retry-after):
        // failing the turn would discard the agent's whole assembled context
        // over a wait measured in seconds.
        response = await sendWithRateLimitRetry(() => send(true));
      } catch (error) {
        return {
          ok: false,
          code: "network_error",
          message: error instanceof Error ? error.message : String(error),
        };
      }

      let text = await response.text();
      // Opus 4.7+ reject `temperature` (and top_p/top_k) — retry once without it.
      if (!response.ok && typeof input.temperature === "number" && isTemperatureUnsupported(text)) {
        try {
          response = await sendWithRateLimitRetry(() => send(false));
          text = await response.text();
        } catch (error) {
          return {
            ok: false,
            code: "network_error",
            message: error instanceof Error ? error.message : String(error),
          };
        }
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

// Mark the final tool's schema with a cache breakpoint so the whole tool
// catalog (stable across the run) is served from cache after the first turn.
// Mutates the freshly-mapped tool objects in place; no-op when caching is off
// or there are no tools.
function withToolCacheBreakpoint(tools: JsonObject[], promptCache: boolean): JsonObject[] {
  if (!promptCache || tools.length === 0) return tools;
  const last = tools[tools.length - 1];
  if (last) last.cache_control = { type: "ephemeral" };
  return tools;
}

// Attach a cache breakpoint to the last content block of the last message.
// `cache_control` must sit on a block, so a string-content message is widened
// into a single text block first. Mutates the freshly-mapped message objects;
// never touches earlier messages, so a previously-written cache prefix stays
// byte-identical and keeps hitting.
function withConversationCacheBreakpoint(
  messages: JsonObject[],
  promptCache: boolean,
): JsonObject[] {
  if (!promptCache || messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (!last) return messages;
  if (typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
    return messages;
  }
  if (Array.isArray(last.content) && last.content.length > 0) {
    const block = last.content[last.content.length - 1];
    if (block && typeof block === "object" && !Array.isArray(block)) {
      (block as JsonObject).cache_control = { type: "ephemeral" };
    }
  }
  return messages;
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
