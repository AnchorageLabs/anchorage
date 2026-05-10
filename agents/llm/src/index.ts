import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonObject | JsonValue[] | boolean | null | number | string;

export type LlmProvider =
  | "anthropic"
  | "aws-bedrock"
  | "kimi"
  | "moonshot"
  | "openai"
  | "openai-compatible";

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

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
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

  switch (provider.value) {
    case "anthropic":
      return resolveAnthropicConfig(defaults);
    case "aws-bedrock":
      return resolveBedrockConfig(defaults);
    case "openai":
      return resolveOpenAiConfig(defaults);
    case "openai-compatible":
      return resolveOpenAiCompatibleConfig(defaults, provider.value);
    case "kimi":
    case "moonshot":
      return resolveMoonshotConfig(defaults, provider.value);
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
    case "kimi":
    case "moonshot":
    case "openai":
    case "openai-compatible":
      return requestChatCompletion(config, request);
  }
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

function resolveProvider(): LlmResult<LlmProvider> {
  const explicit = process.env.ANCHORAGE_LLM_PROVIDER;
  if (explicit && explicit.trim().length > 0) {
    const provider = normalizeProvider(explicit);
    if (provider) return { ok: true, value: provider };
    return {
      ok: false,
      message:
        "ANCHORAGE_LLM_PROVIDER must be one of anthropic, openai, openai-compatible, moonshot, kimi, bedrock.",
    };
  }

  if (process.env.ANTHROPIC_API_KEY) return { ok: true, value: "anthropic" };
  if (process.env.OPENAI_API_KEY) return { ok: true, value: "openai" };
  if (process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY) {
    return { ok: true, value: "moonshot" };
  }
  if (process.env.ANCHORAGE_LLM_API_KEY && process.env.ANCHORAGE_LLM_BASE_URL) {
    return { ok: true, value: "openai-compatible" };
  }
  if (hasBedrockAuth()) return { ok: true, value: "aws-bedrock" };

  return {
    ok: false,
    message:
      "Set ANCHORAGE_LLM_PROVIDER plus provider credentials, or configure ANTHROPIC_API_KEY, OPENAI_API_KEY, MOONSHOT_API_KEY, KIMI_API_KEY, ANCHORAGE_LLM_API_KEY with ANCHORAGE_LLM_BASE_URL, or AWS Bedrock credentials.",
  };
}

function normalizeProvider(value: string): null | LlmProvider {
  switch (value.trim().toLowerCase()) {
    case "anthropic":
    case "claude":
      return "anthropic";
    case "aws-bedrock":
    case "bedrock":
      return "aws-bedrock";
    case "openai":
      return "openai";
    case "openai-compatible":
    case "openai_compatible":
    case "compatible":
      return "openai-compatible";
    case "kimi":
      return "kimi";
    case "moonshot":
      return "moonshot";
    default:
      return null;
  }
}

function resolveAnthropicConfig(defaults: LlmRoleDefaults): LlmResult<LlmConfig> {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANCHORAGE_LLM_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      message: "Set ANTHROPIC_API_KEY or ANCHORAGE_LLM_API_KEY for the Anthropic provider.",
    };
  }

  return {
    ok: true,
    value: {
      provider: "anthropic",
      apiKey,
      baseUrl: trimTrailingSlash(
        process.env.ANTHROPIC_BASE_URL ||
          process.env.ANCHORAGE_LLM_BASE_URL ||
          "https://api.anthropic.com/v1",
      ),
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

function resolveOpenAiConfig(defaults: LlmRoleDefaults): LlmResult<LlmConfig> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.ANCHORAGE_LLM_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      message: "Set OPENAI_API_KEY or ANCHORAGE_LLM_API_KEY for the OpenAI provider.",
    };
  }

  return {
    ok: true,
    value: {
      provider: "openai",
      apiKey,
      baseUrl: trimTrailingSlash(
        process.env.OPENAI_BASE_URL ||
          process.env.ANCHORAGE_LLM_BASE_URL ||
          "https://api.openai.com/v1",
      ),
      model: resolveModel(defaults, defaults.openaiModel || "gpt-4.1"),
      tool: "openai.chat.completions",
    },
  };
}

function resolveOpenAiCompatibleConfig(
  defaults: LlmRoleDefaults,
  provider: "openai-compatible",
): LlmResult<LlmConfig> {
  const apiKey = process.env.ANCHORAGE_LLM_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      message: "Set ANCHORAGE_LLM_API_KEY for the OpenAI-compatible provider.",
    };
  }

  const baseUrl = process.env.ANCHORAGE_LLM_BASE_URL || process.env.OPENAI_BASE_URL;
  if (!baseUrl) {
    return {
      ok: false,
      message: "Set ANCHORAGE_LLM_BASE_URL for the OpenAI-compatible provider.",
    };
  }

  const model = resolveOptionalModel(defaults);
  if (!model) {
    return {
      ok: false,
      message: `Set ${roleModelEnvName(defaults.role)} or ANCHORAGE_LLM_MODEL for the OpenAI-compatible provider.`,
    };
  }

  return {
    ok: true,
    value: {
      provider,
      apiKey,
      baseUrl: trimTrailingSlash(baseUrl),
      model,
      tool: "openai.chat.completions",
    },
  };
}

function resolveMoonshotConfig(
  defaults: LlmRoleDefaults,
  provider: "kimi" | "moonshot",
): LlmResult<LlmConfig> {
  const apiKey =
    process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY || process.env.ANCHORAGE_LLM_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      message: "Set MOONSHOT_API_KEY, KIMI_API_KEY, or ANCHORAGE_LLM_API_KEY for Kimi/Moonshot.",
    };
  }

  const model = resolveOptionalModel(defaults);
  if (!model) {
    return {
      ok: false,
      message: `Set ${roleModelEnvName(defaults.role)} or ANCHORAGE_LLM_MODEL for Kimi/Moonshot.`,
    };
  }

  return {
    ok: true,
    value: {
      provider,
      apiKey,
      baseUrl: trimTrailingSlash(
        process.env.MOONSHOT_BASE_URL ||
          process.env.KIMI_BASE_URL ||
          process.env.ANCHORAGE_LLM_BASE_URL ||
          "https://api.moonshot.ai/v1",
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
  const response = await postJson(`${config.baseUrl}/messages`, {
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": config.apiKey ?? "",
    },
    body: {
      model: config.model,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      system: [anthropicSystemBlock(request.system)],
      messages: [{ role: "user", content: request.user }],
    },
  });
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
  const response = await postJson(`${config.baseUrl}/chat/completions`, {
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
      max_tokens: request.maxTokens,
      temperature: request.temperature,
    },
  });
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
  let response: unknown;
  try {
    const client = new BedrockRuntimeClient({ region: config.region });
    response = await client.send(
      new ConverseCommand({
        modelId: config.model,
        system: [{ text: request.system }],
        messages: [{ role: "user", content: [{ text: request.user }] }],
        inferenceConfig: { maxTokens: request.maxTokens, temperature: request.temperature },
      }),
    );
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
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
