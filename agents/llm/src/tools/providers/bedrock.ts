import {
  type ContentBlock as BedrockContentBlock,
  type Message as BedrockMessage,
  BedrockRuntimeClient,
  type SystemContentBlock as BedrockSystemContentBlock,
  type Tool as BedrockTool,
  CachePointType,
  ConverseCommand,
  type ConverseCommandInput,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  ContentBlock,
  JsonObject,
  LoopMessage,
  ProviderAdapter,
  ProviderTurnInput,
  ProviderTurnResult,
  ToolDefinition,
} from "../types.js";
import { isPromptCachingUnsupported, isTemperatureUnsupported } from "./param-support.js";

export interface BedrockProviderConfig {
  model: string;
  region?: string;
  // Insert Converse `cachePoint` blocks (system + tools + last message) so the
  // stable prompt prefix and growing conversation history bill at the cached
  // rate. On by default; a model that rejects caching transparently retries
  // without it (see isPromptCachingUnsupported). Lossless either way.
  promptCache?: boolean;
}

const CACHE_POINT: { cachePoint: { type: CachePointType } } = {
  cachePoint: { type: CachePointType.DEFAULT },
};

/**
 * Build a ProviderAdapter that talks to AWS Bedrock via the Converse API with
 * native tool use (`toolConfig`). The Converse message shape differs from our
 * internal blocks:
 *   - text  → { text }
 *   - tool_use   → { toolUse: { toolUseId, name, input } }
 *   - tool_result → { toolResult: { toolUseId, content: [{ text }], status } }
 * Tool results ride inside a user message (same as our internal model), so the
 * mapping is one message in / one message out.
 *
 * Credentials come from the standard AWS chain (env, profile, role, bearer
 * token); the caller only supplies a region.
 */
export function createBedrockProvider(config: BedrockProviderConfig): ProviderAdapter {
  const client = new BedrockRuntimeClient({ region: config.region });
  const promptCache = config.promptCache ?? true;

  return {
    name: "aws-bedrock",
    model: config.model,
    async requestTurn(input: ProviderTurnInput): Promise<ProviderTurnResult> {
      const messages = input.messages.map(toBedrockMessage);
      const tools = input.tools.map(toBedrockTool);

      const send = (includeTemperature: boolean, includeCache: boolean) => {
        const commandInput: ConverseCommandInput = {
          modelId: config.model,
          // A cache point after the last message turns the conversation prefix
          // into a cache write each turn; the next turn reads the longest
          // matching prefix. Lossless — the model sees identical content.
          messages: includeCache ? withMessageCachePoint(messages) : messages,
          inferenceConfig: {
            maxTokens: input.maxTokens,
            ...(includeTemperature && typeof input.temperature === "number"
              ? { temperature: input.temperature }
              : {}),
          },
        };
        if (input.system.length > 0) {
          const systemBlocks: BedrockSystemContentBlock[] = [{ text: input.system }];
          if (includeCache) systemBlocks.push(CACHE_POINT);
          commandInput.system = systemBlocks;
        }
        // Converse rejects an empty tools array; only attach when present. A
        // trailing cache point caches the (stable) tool catalog.
        if (tools.length > 0) {
          commandInput.toolConfig = {
            tools: includeCache ? [...tools, CACHE_POINT] : tools,
          };
        }
        return client.send(new ConverseCommand(commandInput));
      };

      // Caching is additive and lossless; temperature may be rejected by newer
      // models. Either rejection triggers one narrowed retry that drops only the
      // offending feature, so the turn never fails over a tunable.
      let useCache = promptCache;
      let response: Awaited<ReturnType<typeof send>>;
      try {
        response = await send(true, useCache);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const dropTemp = typeof input.temperature === "number" && isTemperatureUnsupported(message);
        const dropCache = useCache && isPromptCachingUnsupported(message);
        if (dropTemp || dropCache) {
          if (dropCache) useCache = false;
          try {
            response = await send(!dropTemp, useCache);
          } catch (retryError) {
            return {
              ok: false,
              code: "bedrock_error",
              message: retryError instanceof Error ? retryError.message : String(retryError),
            };
          }
        } else {
          return { ok: false, code: "bedrock_error", message };
        }
      }

      const rawBlocks = response.output?.message?.content ?? [];
      const blocks = rawBlocks
        .map(fromBedrockBlock)
        .filter((block): block is ContentBlock => block !== null);

      return {
        ok: true,
        content: blocks,
        stopReason: typeof response.stopReason === "string" ? response.stopReason : null,
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
        // Converse surfaces cache usage on the usage block when cachePoint hit.
        cacheReadInputTokens: response.usage?.cacheReadInputTokens ?? 0,
        cacheCreationInputTokens: response.usage?.cacheWriteInputTokens ?? 0,
      };
    },
  };
}

// Append a cache point to the last message's content. Returns a new array with
// the final message shallow-copied, so the original `messages` (reused by the
// no-cache retry path) is never mutated.
function withMessageCachePoint(messages: BedrockMessage[]): BedrockMessage[] {
  if (messages.length === 0) return messages;
  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];
  if (!last) return messages;
  const copy = messages.slice();
  copy[lastIndex] = { ...last, content: [...(last.content ?? []), CACHE_POINT] };
  return copy;
}

function toBedrockTool(tool: ToolDefinition): BedrockTool {
  return {
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: tool.inputSchema },
    },
  };
}

function toBedrockMessage(message: LoopMessage): BedrockMessage {
  const content =
    typeof message.content === "string"
      ? [{ text: message.content }]
      : message.content.map(toBedrockBlock);
  return { role: message.role, content };
}

function toBedrockBlock(block: ContentBlock): BedrockContentBlock {
  if (block.type === "text") return { text: block.text };
  if (block.type === "tool_use") {
    return { toolUse: { toolUseId: block.id, name: block.name, input: block.input } };
  }
  // tool_result
  const text =
    typeof block.content === "string" ? block.content : flattenBlocksToString(block.content);
  return {
    toolResult: {
      toolUseId: block.tool_use_id,
      content: [{ text }],
      ...(block.is_error ? { status: "error" as const } : {}),
    },
  };
}

function fromBedrockBlock(block: BedrockContentBlock): ContentBlock | null {
  if ("text" in block && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }
  if ("toolUse" in block && block.toolUse) {
    const { toolUseId, name, input } = block.toolUse;
    if (typeof toolUseId !== "string" || typeof name !== "string") return null;
    const parsedInput =
      typeof input === "object" && input !== null && !Array.isArray(input)
        ? (input as JsonObject)
        : {};
    return { type: "tool_use", id: toolUseId, name, input: parsedInput };
  }
  return null;
}

function flattenBlocksToString(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}
