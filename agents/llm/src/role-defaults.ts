import type { LlmRoleDefaults } from "./index.js";

// Fleet-wide default model fleet, in one place. Bumping the default Claude / GPT
// for every agent is a single edit here instead of an 8-file change. Each agent
// imports its row (e.g. `ROLE_DEFAULTS.coder`) and passes it to
// `resolveLlmConfig`; per-deploy overrides still flow through the env vars
// `ANCHORAGE_LLM_MODEL` / `ANCHORAGE_<ROLE>_MODEL` (see resolveOptionalModel).
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const DEFAULT_BEDROCK_MODEL = "us.anthropic.claude-sonnet-4-6";
const DEFAULT_OPENAI_MODEL = "gpt-4.1";

function role(
  name: string,
  overrides: Partial<Omit<LlmRoleDefaults, "role">> = {},
): LlmRoleDefaults {
  return {
    role: name,
    anthropicModel: DEFAULT_ANTHROPIC_MODEL,
    bedrockModel: DEFAULT_BEDROCK_MODEL,
    openaiModel: DEFAULT_OPENAI_MODEL,
    ...overrides,
  };
}

/**
 * Default model fleet keyed by agent role. Keys match the `role` string each
 * agent uses for `ANCHORAGE_<ROLE>_MODEL` resolution — note triage's role is
 * "triage", not "issue-triage".
 */
export const ROLE_DEFAULTS = {
  planner: role("planner"),
  "issue-opener": role("issue-opener"),
  "pr-opener": role("pr-opener"),
  coder: role("coder"),
  // Triage runs a cheaper/faster default on the OpenAI path.
  triage: role("triage", { openaiModel: "gpt-4o" }),
  reviewer: role("reviewer"),
  // Synthesizes the isolated-preview harness (framework detection + per-component
  // stories with mock data) for the runtime gate when no deterministic template
  // fits the repo.
  runtime: role("runtime"),
  // Acts on Notion directly (notes, tasks, databases, wikis) via the Notion tools.
  "notion-worker": role("notion-worker"),
} satisfies Record<string, LlmRoleDefaults>;

export type AgentRole = keyof typeof ROLE_DEFAULTS;
