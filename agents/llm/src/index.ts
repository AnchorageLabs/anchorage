import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { runWithTools } from "./tools/loop.js";
import { createAnthropicProvider } from "./tools/providers/anthropic.js";
import { createBedrockProvider } from "./tools/providers/bedrock.js";
import { createOpenAiProvider } from "./tools/providers/openai.js";
import {
  isMaxCompletionTokensUnsupported,
  isTemperatureUnsupported,
  wantsMaxCompletionTokens,
} from "./tools/providers/param-support.js";
import type { ProviderAdapter, RunWithToolsRequest, RunWithToolsResult } from "./tools/types.js";

export {
  evaluateForbidImports,
  globToRegExp,
  type ImportGraphView,
  matchGlob,
  type ParsedConstraints,
  type PolicyRule,
  type PolicySeverity,
  type PolicyViolation,
  parseConstraints,
} from "./policy.js";
export { GRAPH_FIRST_RULE } from "./prompts.js";
export type { AgentRole } from "./role-defaults.js";
export { ROLE_DEFAULTS } from "./role-defaults.js";
export { webToolsEnabled } from "./tools/budget.js";
export {
  contextRepoPromptBlock,
  contextReposFromEnvelope,
} from "./tools/builtin/context-repos.js";
export { discoveryTools } from "./tools/builtin/discovery.js";
export { getArtifactTool } from "./tools/builtin/get-artifact.js";
export { notionReadTools, notionWriteTools } from "./tools/builtin/notion.js";
export { repoReadTools, repoWriteTools } from "./tools/builtin/repo.js";
export { installedDepDirs, repoContextPromptBlock } from "./tools/builtin/repo-context.js";
export { shellTools } from "./tools/builtin/shell.js";
export { symbolTools } from "./tools/builtin/symbols.js";
export { webTools } from "./tools/builtin/web.js";
// Re-export the tool-loop surface so consumers can `import { runWithTools,
// repoReadTools, ... } from "@anchorage/agent-llm"` without deep imports.
export { runWithTools } from "./tools/loop.js";
export { createAnthropicProvider } from "./tools/providers/anthropic.js";
export { createBedrockProvider } from "./tools/providers/bedrock.js";
export { createOpenAiProvider } from "./tools/providers/openai.js";
export { getIndexStore, type IndexStore } from "./tools/symbols/store.js";
export type {
  AssistantMessage,
  BudgetConfig,
  BudgetState,
  ContentBlock,
  ContextRepoMount,
  ContextSnapshot,
  LoopMessage,
  ProviderAdapter,
  RunWithToolsRequest,
  RunWithToolsResult,
  TextBlock,
  ToolCallRecord,
  ToolContext,
  ToolDefinition,
  ToolEvent,
  ToolEventEmitter,
  ToolHandler,
  ToolHandlerResult,
  ToolResultBlock,
  ToolUseBlock,
  UserMessage,
} from "./tools/types.js";

type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonObject | JsonValue[] | boolean | null | number | string;

export type LlmProvider = "anthropic" | "aws-bedrock" | "openai";

/**
 * Named presets for OpenAI-compatible providers. Setting
 * `ANCHORAGE_LLM_PROVIDER=<preset>` resolves to the generic `openai` adapter
 * pre-filled with the right base URL, credential env, and default model — so a
 * newcomer never needs to know the "use openai + a base URL" handshake. Raw
 * `openai` + `OPENAI_BASE_URL` stays the escape hatch for anything not listed
 * here. Adding a provider = one row below. See MODEL_PROVIDER_WIRING.md §5A.
 */
interface OpenAiPreset {
  /** Preset name (matches the `ANCHORAGE_LLM_PROVIDER` value). */
  name: string;
  /** Default base URL; overridden by `OPENAI_BASE_URL` or `baseUrlEnv`. */
  baseUrl?: string;
  /** Optional env var that supplies the base URL (e.g. self-hosted gateways). */
  baseUrlEnv?: string;
  /** Preferred credential env; falls back to `OPENAI_API_KEY`. */
  apiKeyEnv: string;
  /** Default model id when no `ANCHORAGE_*_MODEL` override is present. */
  defaultModel: string;
}

const OPENAI_COMPAT_PRESETS: Record<string, OpenAiPreset> = {
  openrouter: {
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultModel: "deepseek/deepseek-v4-flash",
  },
  deepseek: {
    name: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-chat",
  },
  moonshot: {
    name: "moonshot",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    defaultModel: "kimi-k2",
  },
  opencode: {
    name: "opencode",
    baseUrlEnv: "OPENCODE_BASE_URL",
    apiKeyEnv: "OPENCODE_API_KEY",
    defaultModel: "",
  },
};

interface ResolvedProvider {
  provider: LlmProvider;
  /** Set when an OpenAI-compatible preset was named; drives base URL/key/model. */
  preset?: OpenAiPreset;
}

export interface LlmRoleDefaults {
  role: string;
  anthropicModel: string;
  bedrockModel: string;
  openaiModel?: string;
}

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  tool: string;
  apiKey?: string;
  baseUrl?: string;
  region?: string;
}

// Anthropic requires a max_tokens; this is the generous default used only when a
// caller leaves maxTokens unset (OpenAI/Bedrock omit the cap entirely instead).
const DEFAULT_ANTHROPIC_MAX_TOKENS = 16000;

export interface LlmRequest {
  system: string;
  user: string;
  /**
   * Output token cap. Optional: when omitted, the OpenAI and Bedrock paths send
   * no cap at all so the model produces as much as it needs (up to its own
   * maximum). The Anthropic path falls back to DEFAULT_ANTHROPIC_MAX_TOKENS
   * because that API requires max_tokens.
   */
  maxTokens?: number;
  /**
   * Sampling temperature. Optional: some models (e.g. Claude Opus 4.8+) have
   * deprecated the parameter and reject requests that include it. When set, the
   * adapter sends it but transparently retries without it if the provider
   * reports the parameter as unsupported — so callers can keep passing a
   * preferred temperature without breaking on models that no longer accept one.
   */
  temperature?: number;
}

export interface LlmCompletion {
  text: string;
  stopReason: null | string;
  inputTokens: number;
  outputTokens: number;
}

export type LlmResult<T> = { ok: true; value: T } | { ok: false; message: string };

export function resolveLlmConfig(defaults: LlmRoleDefaults): LlmResult<LlmConfig> {
  const provider = resolveProvider();
  if (!provider.ok) return { ok: false, message: provider.message };

  switch (provider.value.provider) {
    case "anthropic":
      return resolveAnthropicConfig(defaults);
    case "aws-bedrock":
      return resolveBedrockConfig(defaults);
    case "openai":
      return resolveOpenAiConfig(defaults, provider.value.preset);
  }
}

export async function requestLlmCompletion(
  config: LlmConfig,
  request: LlmRequest,
): Promise<LlmResult<LlmCompletion>> {
  switch (config.provider) {
    case "anthropic":
      return requestAnthropicCompletion(config, request);
    case "aws-bedrock":
      return requestBedrockCompletion(config, request);
    case "openai":
      return requestChatCompletion(config, request);
  }
}

/**
 * Build a tool-loop ProviderAdapter from an existing LlmConfig. Anthropic and
 * OpenAI (incl. Moonshot/Kimi/openai-compatible) are supported. Bedrock is
 * one-shot only — it returns `{ ok: false }` here; use requestLlmCompletion
 * for Bedrock workflows, or switch to ANTHROPIC_API_KEY / OPENAI_API_KEY to
 * enable tool-using agents (coder, planner, reviewer, issue-triage).
 */
export function providerFromLlmConfig(config: LlmConfig): LlmResult<ProviderAdapter> {
  switch (config.provider) {
    case "anthropic":
      if (!config.apiKey) {
        return { ok: false, message: "Anthropic provider requires an API key." };
      }
      return {
        ok: true,
        value: createAnthropicProvider({
          apiKey: config.apiKey,
          model: config.model,
          baseUrl: config.baseUrl,
          promptCache: process.env.ANCHORAGE_LLM_PROMPT_CACHE !== "false",
        }),
      };
    case "openai":
      if (!config.apiKey) {
        return { ok: false, message: "OpenAI provider requires an API key." };
      }
      return {
        ok: true,
        value: createOpenAiProvider({
          apiKey: config.apiKey,
          model: config.model,
          baseUrl: config.baseUrl,
          promptCache: process.env.ANCHORAGE_LLM_PROMPT_CACHE !== "false",
        }),
      };
    case "aws-bedrock":
      return {
        ok: true,
        value: createBedrockProvider({
          model: config.model,
          region: config.region,
          promptCache: process.env.ANCHORAGE_LLM_PROMPT_CACHE !== "false",
        }),
      };
  }
}

/**
 * Convenience: resolve a provider from an LlmConfig and drive the tool loop.
 * Equivalent to `providerFromLlmConfig` + `runWithTools` but saves the agent
 * a few lines.
 */
export async function runWithLlmTools(
  config: LlmConfig,
  request: RunWithToolsRequest,
): Promise<LlmResult<RunWithToolsResult>> {
  const provider = providerFromLlmConfig(config);
  if (!provider.ok) return { ok: false, message: provider.message };
  const result = await runWithTools(provider.value, request);
  return { ok: true, value: result };
}

export function llmEventInput(
  config: LlmConfig,
  extra: JsonObject = {},
): JsonObject & {
  provider: LlmProvider;
  model: string;
  region?: string;
  baseUrl?: string;
} {
  const value: JsonObject & {
    provider: LlmProvider;
    model: string;
    region?: string;
    baseUrl?: string;
  } = {
    provider: config.provider,
    model: config.model,
    ...extra,
  };
  if (config.region) value.region = config.region;
  if (config.baseUrl) value.baseUrl = config.baseUrl;
  return value;
}

function resolveProvider(): LlmResult<ResolvedProvider> {
  const explicit = process.env.ANCHORAGE_LLM_PROVIDER;
  if (explicit && explicit.trim().length > 0) {
    const provider = normalizeProvider(explicit);
    if (provider) return { ok: true, value: provider };
    const presets = Object.keys(OPENAI_COMPAT_PRESETS).join(", ");
    return {
      ok: false,
      message: `ANCHORAGE_LLM_PROVIDER must be one of anthropic, openai, bedrock, or a known preset (${presets}).`,
    };
  }

  // No explicit provider: infer from available credentials.
  if (process.env.ANTHROPIC_API_KEY) return { ok: true, value: { provider: "anthropic" } };
  if (process.env.OPENAI_API_KEY) return { ok: true, value: { provider: "openai" } };
  const preset = inferPresetFromCredentials();
  if (preset) return { ok: true, value: { provider: "openai", preset } };
  if (hasBedrockAuth()) return { ok: true, value: { provider: "aws-bedrock" } };

  return {
    ok: false,
    message:
      "Set ANCHORAGE_LLM_PROVIDER (anthropic | openai | bedrock), or provide credentials: " +
      "ANTHROPIC_API_KEY, OPENAI_API_KEY, or AWS Bedrock credentials.",
  };
}

function normalizeProvider(value: string): null | ResolvedProvider {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "anthropic":
    case "claude":
      return { provider: "anthropic" };
    case "aws-bedrock":
    case "bedrock":
      return { provider: "aws-bedrock" };
    case "openai":
      return { provider: "openai" };
  }
  const preset = OPENAI_COMPAT_PRESETS[normalized];
  if (preset) return { provider: "openai", preset };
  return null;
}

/**
 * When no provider is named, fall back to a preset whose dedicated key env is
 * present (e.g. `DEEPSEEK_API_KEY`). Checked after ANTHROPIC/OPENAI so the
 * generic paths keep priority; first match by registry order wins.
 */
function inferPresetFromCredentials(): OpenAiPreset | undefined {
  for (const preset of Object.values(OPENAI_COMPAT_PRESETS)) {
    if (process.env[preset.apiKeyEnv]) return preset;
  }
  return undefined;
}

function resolveAnthropicConfig(defaults: LlmRoleDefaults): LlmResult<LlmConfig> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, message: "Set ANTHROPIC_API_KEY for the Anthropic provider." };
  }

  return {
    ok: true,
    value: {
      provider: "anthropic",
      apiKey,
      baseUrl: trimTrailingSlash(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1"),
      model: normalizeAnthropicModel(resolveModel(defaults, defaults.anthropicModel)),
      tool: "anthropic.messages",
    },
  };
}

function resolveBedrockConfig(defaults: LlmRoleDefaults): LlmResult<LlmConfig> {
  if (!hasBedrockAuth()) {
    return {
      ok: false,
      message: "Set AWS_BEARER_TOKEN_BEDROCK or standard AWS credentials for Bedrock.",
    };
  }

  return {
    ok: true,
    value: {
      provider: "aws-bedrock",
      region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
      model: resolveModel(defaults, defaults.bedrockModel),
      tool: "bedrock.converse",
    },
  };
}

/**
 * OpenRouter requires Anthropic model IDs with the `anthropic/` prefix (e.g.
 * `anthropic/claude-opus-4-8`). When a bare Claude model ID arrives from an
 * `ANCHORAGE_*_MODEL` env var or per-run selection, prepend the prefix.
 * Already-prefixed IDs (containing `/`) and non-Claude models pass through.
 */
function normalizeOpenRouterModel(preset: OpenAiPreset | undefined, model: string): string {
  if (!model || preset?.name !== "openrouter") return model;
  // Strip the Bedrock us.anthropic. prefix if present before re-prefixing.
  if (model.startsWith("us.anthropic.")) model = model.slice("us.anthropic.".length);
  else if (model.startsWith("anthropic.")) model = model.slice("anthropic.".length);
  // Already has a provider prefix (e.g. deepseek/deepseek-v4-flash).
  if (model.includes("/")) return model;
  // Bare Anthropic model id → prepend the OpenRouter provider prefix.
  if (model.startsWith("claude-")) return `anthropic/${model}`;
  return model;
}

function resolveOpenAiConfig(
  defaults: LlmRoleDefaults,
  preset?: OpenAiPreset,
): LlmResult<LlmConfig> {
  // Preset key env takes priority, then the generic OPENAI_API_KEY fallback.
  const apiKey = (preset ? process.env[preset.apiKeyEnv] : undefined) || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const message = preset
      ? `Set ${preset.apiKeyEnv} (or OPENAI_API_KEY) for the ${preset.name} provider.`
      : "Set OPENAI_API_KEY for the OpenAI provider.";
    return { ok: false, message };
  }

  // Base URL precedence: explicit OPENAI_BASE_URL > preset's baseUrlEnv >
  // preset's static baseUrl > OpenAI default. The preset's default model is the
  // fallback only when the agent's own openaiModel is unset.
  const presetBaseUrl =
    (preset?.baseUrlEnv ? process.env[preset.baseUrlEnv] : undefined) || preset?.baseUrl;

  // A preset with defaultModel:"" (e.g. opencode — a self-hosted gateway with
  // no canonical model name) must NOT silently fall back to "gpt-4.1": that
  // model name would reach a custom gateway that doesn't recognise it. Instead,
  // omit the generic fallback so the guard below surfaces a clear error.
  const presetDefault = preset && preset.defaultModel.length > 0 ? preset.defaultModel : undefined;
  const fallbackModel = presetDefault || defaults.openaiModel || (!preset ? "gpt-4.1" : "");
  const model = normalizeOpenRouterModel(preset, resolveModel(defaults, fallbackModel));
  if (!model) {
    const envName = roleModelEnvName(defaults.role);
    // This branch is only reachable with a preset (presetless paths fall back to
    // "gpt-4.1"), but read the name defensively to satisfy lint without an
    // assertion.
    const providerName = preset?.name ?? "selected";
    return {
      ok: false,
      message:
        `The ${providerName} provider has no default model. ` +
        `Set ${envName} or ANCHORAGE_LLM_MODEL to specify one.`,
    };
  }

  return {
    ok: true,
    value: {
      provider: "openai",
      apiKey,
      baseUrl: trimTrailingSlash(
        process.env.OPENAI_BASE_URL || presetBaseUrl || "https://api.openai.com/v1",
      ),
      model,
      tool: "openai.chat.completions",
    },
  };
}

function resolveModel(defaults: LlmRoleDefaults, fallback: string): string {
  return resolveOptionalModel(defaults) ?? fallback;
}

function resolveOptionalModel(defaults: LlmRoleDefaults): null | string {
  const roleValue = process.env[roleModelEnvName(defaults.role)];
  if (roleValue && roleValue.trim().length > 0) return roleValue.trim();
  const genericValue = process.env.ANCHORAGE_LLM_MODEL;
  if (genericValue && genericValue.trim().length > 0) return genericValue.trim();
  return null;
}

function roleModelEnvName(role: string): string {
  return `ANCHORAGE_${role.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_MODEL`;
}

/**
 * Returns the `{ temperature }` fragment to spread into a request body, or an
 * empty object when temperature should be omitted (caller left it unset, or we
 * are retrying after the model rejected it).
 */
function temperatureBody(request: LlmRequest, include: boolean): { temperature?: number } {
  if (!include || request.temperature === undefined) return {};
  return { temperature: request.temperature };
}

function normalizeAnthropicModel(model: string): string {
  if (model.startsWith("us.anthropic.")) return model.slice("us.anthropic.".length);
  if (model.startsWith("anthropic.")) return model.slice("anthropic.".length);
  return model;
}

function hasBedrockAuth(): boolean {
  return Boolean(
    process.env.AWS_BEARER_TOKEN_BEDROCK ||
      process.env.AWS_ACCESS_KEY_ID ||
      process.env.AWS_PROFILE ||
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
  );
}

async function requestAnthropicCompletion(
  config: LlmConfig,
  request: LlmRequest,
): Promise<LlmResult<LlmCompletion>> {
  const send = (includeTemperature: boolean) =>
    postJson(`${config.baseUrl}/messages`, {
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": config.apiKey ?? "",
      },
      body: {
        model: config.model,
        max_tokens: request.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
        ...temperatureBody(request, includeTemperature),
        system: [anthropicSystemBlock(request.system)],
        messages: [{ role: "user", content: request.user }],
      },
    });

  let response = await send(true);
  if (
    !response.ok &&
    request.temperature !== undefined &&
    isTemperatureUnsupported(response.message)
  ) {
    response = await send(false);
  }
  if (!response.ok) return { ok: false, message: response.message };

  const value = response.value;
  const content = Array.isArray(value.content) ? value.content : [];
  const text = content
    .map((block) => (isObject(block) && typeof block.text === "string" ? block.text : null))
    .filter(isString)
    .join("\n")
    .trim();
  if (!text) return { ok: false, message: "Anthropic response did not include text content." };

  const usage = isObject(value.usage) ? value.usage : {};
  return {
    ok: true,
    value: {
      text,
      stopReason: typeof value.stop_reason === "string" ? value.stop_reason : null,
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    },
  };
}

function anthropicSystemBlock(text: string): JsonObject {
  const block: JsonObject = { type: "text", text };
  if (process.env.ANCHORAGE_LLM_PROMPT_CACHE !== "false") {
    block.cache_control = { type: "ephemeral" };
  }
  return block;
}

async function requestChatCompletion(
  config: LlmConfig,
  request: LlmRequest,
): Promise<LlmResult<LlmCompletion>> {
  // Token budget parameter: OpenAI's newer (reasoning) models require
  // `max_completion_tokens` and reject `max_tokens`; older models take
  // `max_tokens`. Start with the modern default, then flex on the API's error
  // so any model works without us tracking model names.
  let tokenParam: "max_completion_tokens" | "max_tokens" = "max_completion_tokens";
  let includeTemperature = request.temperature !== undefined;

  const send = () =>
    postJson(`${config.baseUrl}/chat/completions`, {
      headers: {
        authorization: `Bearer ${config.apiKey ?? ""}`,
        "content-type": "application/json",
      },
      body: {
        model: config.model,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        ...(request.maxTokens !== undefined ? { [tokenParam]: request.maxTokens } : {}),
        ...(includeTemperature && request.temperature !== undefined
          ? { temperature: request.temperature }
          : {}),
      },
    });

  let response = await send();
  // Retry up to twice, dropping/flipping whichever parameter the model rejects
  // (temperature for reasoning models; the token-budget param either way).
  for (let attempt = 0; attempt < 2 && !response.ok; attempt++) {
    let changed = false;
    if (includeTemperature && isTemperatureUnsupported(response.message)) {
      includeTemperature = false;
      changed = true;
    }
    if (tokenParam === "max_tokens" && wantsMaxCompletionTokens(response.message)) {
      tokenParam = "max_completion_tokens";
      changed = true;
    } else if (
      tokenParam === "max_completion_tokens" &&
      isMaxCompletionTokensUnsupported(response.message)
    ) {
      tokenParam = "max_tokens";
      changed = true;
    }
    if (!changed) break;
    response = await send();
  }
  if (!response.ok) return { ok: false, message: response.message };

  const value = response.value;
  const choices = Array.isArray(value.choices) ? value.choices : [];
  const first = choices.find(isObject);
  if (!first) return { ok: false, message: "Chat completion response did not include choices." };

  const message = isObject(first.message) ? first.message : {};
  const text = openAiContentText(message.content);
  if (!text)
    return { ok: false, message: "Chat completion response did not include text content." };

  const usage = isObject(value.usage) ? value.usage : {};
  return {
    ok: true,
    value: {
      text,
      stopReason: typeof first.finish_reason === "string" ? first.finish_reason : null,
      inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
      outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
    },
  };
}

function openAiContentText(content: JsonValue | undefined): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!isObject(block)) return null;
      if (typeof block.text === "string") return block.text;
      if (typeof block.content === "string") return block.content;
      return null;
    })
    .filter(isString)
    .join("\n")
    .trim();
}

async function requestBedrockCompletion(
  config: LlmConfig,
  request: LlmRequest,
): Promise<LlmResult<LlmCompletion>> {
  const client = new BedrockRuntimeClient({ region: config.region });
  const send = (includeTemperature: boolean) =>
    client.send(
      new ConverseCommand({
        modelId: config.model,
        system: [{ text: request.system }],
        messages: [{ role: "user", content: [{ text: request.user }] }],
        inferenceConfig: {
          ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
          ...(includeTemperature && request.temperature !== undefined
            ? { temperature: request.temperature }
            : {}),
        },
      }),
    );

  let response: unknown;
  try {
    response = await send(true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (request.temperature !== undefined && isTemperatureUnsupported(message)) {
      try {
        response = await send(false);
      } catch (retryError) {
        return {
          ok: false,
          message: retryError instanceof Error ? retryError.message : String(retryError),
        };
      }
    } else {
      return { ok: false, message };
    }
  }

  if (!isObject(response)) return { ok: false, message: "Bedrock response was not an object." };
  const output = isObject(response.output) ? response.output : {};
  const message = isObject(output.message) ? output.message : {};
  if (!Array.isArray(message.content)) {
    return { ok: false, message: "Bedrock response did not include output.message.content[]." };
  }

  const text = message.content
    .map((block) => (isObject(block) ? block.text : null))
    .filter(isString)
    .join("\n")
    .trim();
  if (!text) return { ok: false, message: "Bedrock response did not include text content." };

  const usage = isObject(response.usage) ? response.usage : {};
  return {
    ok: true,
    value: {
      text,
      stopReason: typeof response.stopReason === "string" ? response.stopReason : null,
      inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : 0,
      outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : 0,
    },
  };
}

async function postJson(
  url: string,
  options: { headers: Record<string, string>; body: JsonObject },
): Promise<LlmResult<JsonObject>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: options.headers,
      body: JSON.stringify(options.body),
    });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const text = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      message: `${response.status} ${response.statusText}: ${truncate(text, 1000)}`,
    };
  }

  try {
    const parsed = JSON.parse(text);
    if (!isObject(parsed)) return { ok: false, message: "LLM HTTP response was not an object." };
    return { ok: true, value: parsed };
  } catch (error) {
    return {
      ok: false,
      message: `LLM HTTP response was not valid JSON: ${(error as Error).message}`,
    };
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
