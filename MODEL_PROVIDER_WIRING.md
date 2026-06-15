# Model & Provider Wiring — Deep Analysis + Change Plan

> Goal: add new LLM providers (OpenCode, OpenRouter, DeepSeek, Anthropic, OpenAI,
> Moonshot/Kimi, "or whatever") and new models **without many code
> modifications**. This document maps exactly how models are wired today, where
> the friction is, and the concrete changes to make adding a provider/model a
> config-only operation.

Last updated: 2026-06-14.

---

## 0. TL;DR

- The LLM abstraction lives in **one package**: `@anchorage/agent-llm`
  (`agents/llm/src/index.ts`). It supports **three providers**: `anthropic`,
  `aws-bedrock`, `openai`.
- The `openai` provider is a **generic OpenAI-compatible client** — it already
  works with any endpoint that speaks Chat Completions (OpenRouter, DeepSeek,
  Moonshot/Kimi, OpenCode, local llama.cpp, etc.) just by setting
  `OPENAI_BASE_URL` + `OPENAI_API_KEY`. Tool-calling is standard `tool_calls`.
  **So "adding a provider" is mostly already possible today via env vars.**
- Three real friction points keep it from being friction-free:
  1. **`normalizeProvider()`** only accepts the literal strings
     `anthropic|claude|aws-bedrock|bedrock|openai`. There is no `openrouter`,
     `deepseek`, `moonshot`, `opencode` alias, so a newcomer has to know "use
     `openai` + a base URL" rather than naming their provider.
  2. **Role defaults are duplicated inline across 8 agents** (`anthropicModel` /
     `bedrockModel` / `openaiModel` hard-coded in each `index.ts`). Changing the
     default model fleet-wide is an 8-file edit.
  3. **Pricing table** in the orchestrator (`run-manifest.ts`) is a separate
     private-repo concern with (a) a prefix-match bug and (b) no entries for the
     new providers. (Bug already patched — see §6.)
- Recommended end state: a **provider registry** (named presets that fill in
  base URL + default model + which credential env to read) so adding a provider
  is a single table entry, and a **shared role-defaults module** so adding/
  changing a model is a single edit. Neither requires touching the 8 agents.

---

## 1. Where everything lives

| Concern | Repo | File |
| --- | --- | --- |
| Provider/model resolution, all 3 adapters | `anchorage` (public) | `agents/llm/src/index.ts` |
| OpenAI-compatible tool-loop adapter | `anchorage` | `agents/llm/src/tools/providers/openai.ts` |
| Anthropic / Bedrock tool-loop adapters | `anchorage` | `agents/llm/src/tools/providers/{anthropic,bedrock}.ts` |
| Per-agent role defaults (duplicated) | `anchorage` | `agents/<name>/src/index.ts` |
| Env whitelist that reaches spawned agents | `anchorage-orchestrator` (private) | `src/adapters/local-cli-agent-runner/local-cli-agent-runner.ts` |
| Per-client BYO-key → env mapping | `anchorage-orchestrator` | `src/apps/server/clients.ts` (`llmEnvFromConfig`) |
| Pricing table + cost fold | `anchorage-orchestrator` | `src/domain/run-manifest.ts` |
| Env documentation | `anchorage-orchestrator` | `.env.example` |

---

## 2. How a model is resolved at runtime (the happy path)

`resolveLlmConfig(defaults: LlmRoleDefaults)` in `agents/llm/src/index.ts`:

1. **Pick the provider** — `resolveProvider()` (line 216):
   - If `ANCHORAGE_LLM_PROVIDER` is set → `normalizeProvider()` it.
   - Else infer from credentials present: `ANTHROPIC_API_KEY` → anthropic,
     `OPENAI_API_KEY` → openai, bedrock auth → aws-bedrock.
2. **Build provider config** — switch on provider:
   - `resolveAnthropicConfig` (255): `ANTHROPIC_API_KEY`, base URL
     `ANTHROPIC_BASE_URL || https://api.anthropic.com/v1`, model
     `resolveModel(defaults, defaults.anthropicModel)`.
   - `resolveBedrockConfig` (273): bedrock auth, region, model
     `defaults.bedrockModel`. **One-shot only — no tool loop.**
   - `resolveOpenAiConfig` (292): `OPENAI_API_KEY`, base URL
     `OPENAI_BASE_URL || https://api.openai.com/v1`, model
     `defaults.openaiModel || "gpt-4.1"`.
3. **Pick the model id** — `resolveModel`/`resolveOptionalModel` (310-320):
   `ANCHORAGE_<ROLE>_MODEL` → `ANCHORAGE_LLM_MODEL` → per-provider default.
   `roleModelEnvName("pr-opener")` → `ANCHORAGE_PR_OPENER_MODEL`.

### Env var surface (today)

| Var | Effect |
| --- | --- |
| `ANCHORAGE_LLM_PROVIDER` | `anthropic` \| `openai` \| `bedrock` (+ aliases `claude`, `aws-bedrock`) |
| `ANCHORAGE_LLM_MODEL` | Override model for all roles |
| `ANCHORAGE_<ROLE>_MODEL` | Override model for one role (e.g. `ANCHORAGE_CODER_MODEL`) |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Anthropic creds + endpoint |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | OpenAI-compatible creds + endpoint |
| `AWS_BEARER_TOKEN_BEDROCK` / AWS creds | Bedrock auth |

---

## 3. The OpenAI-compatible adapter is the universal path

`agents/llm/src/tools/providers/openai.ts` is a fully generic Chat Completions
client:

- `baseUrl` is configurable (`OPENAI_BASE_URL`), trailing slash trimmed.
- Tools serialized as `{ type: "function", function: {...} }`; assistant
  `tool_calls[]` normalized back into internal `tool_use` blocks; tool results
  fan out to `role: "tool"` messages. **Standard OpenAI tool protocol.**
- Auto-retries flip `max_tokens`↔`max_completion_tokens` and drop
  `temperature` based on the API's error text — so it tolerates both classic and
  reasoning-model parameter rules without per-model branching.
- Reads `usage.prompt_tokens` / `usage.completion_tokens`.

**Implication:** OpenRouter, DeepSeek, Moonshot/Kimi, OpenCode, Together,
Groq, local servers — anything OpenAI-compatible — already works **today** with:

```bash
ANCHORAGE_LLM_PROVIDER=openai
OPENAI_BASE_URL=https://openrouter.ai/api/v1     # or deepseek / moonshot / opencode
OPENAI_API_KEY=sk-...
ANCHORAGE_LLM_MODEL=anthropic/claude-sonnet-4-6  # provider-specific model id
```

No code change is required to *use* these. The work below is about making it
*ergonomic and named*, and about pricing/observability catching up.

---

## 4. The three friction points (and why they hurt)

### 4.1 `normalizeProvider()` has no aliases for new providers
`agents/llm/src/index.ts:240` only maps to the 3 internal providers. A user who
sets `ANCHORAGE_LLM_PROVIDER=openrouter` gets a hard error
("must be one of anthropic, openai, bedrock"). They must instead know the
"secret handshake" (`openai` + base URL). This is the single biggest "I have to
read the code to add my provider" papercut.

### 4.2 Role defaults duplicated across 8 agents
Every agent hard-codes its own defaults block, e.g.:

```ts
const defaults = {
  role: "coder",
  anthropicModel: "claude-sonnet-4-6",
  bedrockModel: "us.anthropic.claude-sonnet-4-6",
  openaiModel: "gpt-4.1",
};
```

Files: `agents/{planner,issue-opener,pr-opener,coder,issue-triage,reviewer,...}/src/index.ts`.
Bumping the fleet to a new Claude/GPT default = editing all of them. (`issue-triage`
even diverges with `gpt-4o`.) Easy to drift, easy to miss one.

### 4.3 Pricing table (orchestrator) lags and had a matching bug
`run-manifest.ts` `DEFAULT_PRICING` only had 5 entries, keyed inconsistently
(haiku keyed by full dated id `claude-haiku-4-5-20251001`), and `priceFor` only
matched when the **logged** model *extended* the key. Logged id
`claude-haiku-4-5` (shorter) never matched the longer key → **$0 cost**. Also no
bedrock-prefixed (`us.anthropic.*`) or new-provider entries. (Patched in §6.)

---

## 5. Recommended changes (config-first, low-churn)

Ordered by impact ÷ effort. Items A–C make adding a provider/model
config-only; D–F are polish.

### A. Provider registry / presets (kills friction 4.1)
Add a small table in `agents/llm/src/index.ts` (or a sibling
`providers.ts`) mapping a **named preset** → how to fill the OpenAI-compatible
config:

```ts
// name -> { baseUrl, apiKeyEnv, defaultModel }
const OPENAI_COMPAT_PRESETS: Record<string, {
  baseUrl: string; apiKeyEnv: string; defaultModel: string;
}> = {
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", defaultModel: "anthropic/claude-sonnet-4-6" },
  deepseek:   { baseUrl: "https://api.deepseek.com/v1",   apiKeyEnv: "DEEPSEEK_API_KEY",  defaultModel: "deepseek-chat" },
  moonshot:   { baseUrl: "https://api.moonshot.ai/v1",    apiKeyEnv: "MOONSHOT_API_KEY",  defaultModel: "kimi-k2" },
  opencode:   { baseUrl: process.env.OPENCODE_BASE_URL ?? "", apiKeyEnv: "OPENCODE_API_KEY", defaultModel: "" },
};
```

Then:
- `normalizeProvider()` returns `"openai"` for any preset name (so the rest of
  the pipeline is unchanged), **and** the preset name is remembered.
- `resolveOpenAiConfig()` consults the preset for `baseUrl` / api-key env /
  default model **unless** `OPENAI_BASE_URL` / `OPENAI_API_KEY` /
  `ANCHORAGE_LLM_MODEL` explicitly override.

Result: `ANCHORAGE_LLM_PROVIDER=deepseek` + `DEEPSEEK_API_KEY=...` "just works",
no base-URL knowledge required. Adding a new provider = one registry row.

> Keep raw `openai` + `OPENAI_BASE_URL` working as the escape hatch for
> anything not in the registry — that is the "or whatever" case.

### B. Centralize role defaults (kills friction 4.2)
Create `agents/llm/src/role-defaults.ts` exporting one map keyed by role:

```ts
export const ROLE_DEFAULTS: Record<string, LlmRoleDefaults> = {
  coder:   { role: "coder",   anthropicModel: "claude-sonnet-4-6", bedrockModel: "us.anthropic.claude-sonnet-4-6", openaiModel: "gpt-4.1" },
  planner: { role: "planner", /* ... */ },
  // ...one row per agent
};
```

Each agent imports `ROLE_DEFAULTS["coder"]` instead of declaring inline.
Fleet-wide model bumps become a one-file edit. (Optionally allow a single
`ANCHORAGE_DEFAULT_ANTHROPIC_MODEL` etc. to override the column without code.)

### C. Pricing as config, not code (orchestrator)
`ANCHORAGE_LLM_PRICING_JSON` already merges over `DEFAULT_PRICING` at runtime —
so **new model prices need no deploy**. Document this prominently (see §6) and
keep `DEFAULT_PRICING` current as the safety net. With the canonical-id matching
fix (§6), a single canonical key now prices the bare id, the dated id, the
bedrock alias, and the openrouter alias.

### D. Expand the orchestrator env whitelist (only if new key names added)
`INHERITED_LLM_ENV_KEYS` in `local-cli-agent-runner.ts` lists exactly which env
vars reach a spawned agent. It currently passes `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`,
`AWS_BEARER_TOKEN_BEDROCK`, plus patterns `/^ANCHORAGE_LLM_/` and
`/^ANCHORAGE_..._MODEL$/`.
- If you keep reusing `OPENAI_API_KEY`/`OPENAI_BASE_URL` for compat providers
  (recommended), **no change needed**.
- If you add per-provider key names (`OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`,
  …), add them here (or a `/_API_KEY$/` pattern — but scope it carefully so
  unrelated secrets aren't forwarded).

### E. Extend per-client BYO-key mapping (orchestrator)
`llmEnvFromConfig` in `src/apps/server/clients.ts` currently accepts only
`anthropic`/`openai`/`openai-compatible` and returns `null` otherwise. Add the
new preset names so a client can pick "deepseek" in their config and have the
server emit the right `ANCHORAGE_LLM_PROVIDER` + key env.

### F. Update `.env.example` + docs
List the new preset names and their key env vars; show the OpenRouter/DeepSeek
examples from §3.

---

## 6. Pricing patch (already applied — orchestrator)

File: `anchorage-orchestrator/src/domain/run-manifest.ts`.

**Bug:** `priceFor` matched only when `model.startsWith(key)`. Logged
`claude-haiku-4-5` never matched key `claude-haiku-4-5-20251001` (key longer) →
haiku runs costed `$0`.

**Fix applied:**
1. Re-keyed `DEFAULT_PRICING` by **canonical (unversioned)** ids and added
   opus-4-6, sonnet-4-5, gpt-4o(+mini), deepseek-chat/reasoner, kimi-k2,
   moonshot-v1-128k.
2. Added `canonicalModelId()` to strip provider routing prefixes:
   bedrock `us.anthropic.` and openrouter `vendor/`.
3. Made `priceFor` match **bidirectionally** (key extends model *or* model
   extends key), longest-overlap wins, after normalization.

Net: one canonical key now prices the bare id, the dated id, the bedrock alias
(`us.anthropic.claude-haiku-4-5`), and the openrouter alias
(`anthropic/claude-haiku-4-5`). Typecheck passes (`tsc -b --noEmit`).

> Still config-overridable at runtime via `ANCHORAGE_LLM_PRICING_JSON` — no
> deploy needed to add/adjust a price.

---

## 7. Step-by-step: "add a new provider" after these changes

1. Add a row to `OPENAI_COMPAT_PRESETS` (base URL, key env, default model). *(A)*
2. (If a new key-env name) add it to the orchestrator whitelist. *(D)*
3. (If clients can choose it) add it to `llmEnvFromConfig`. *(E)*
4. Add prices to `DEFAULT_PRICING` (or just ship `ANCHORAGE_LLM_PRICING_JSON`). *(C/6)*
5. Document in `.env.example`. *(F)*

"Add a new model on an existing provider" = price entry (or pricing JSON) +,
if it should be a default, one row in `ROLE_DEFAULTS`.

---

## 8. Open questions / decisions for you

- **Per-provider key names vs reuse `OPENAI_API_KEY`?** Reusing is zero-friction
  but means one key at a time; named keys (`DEEPSEEK_API_KEY`) allow several
  configured simultaneously at the cost of whitelist edits. Recommend named keys
  in the registry, falling back to `OPENAI_API_KEY`.
- **Bedrock tool loop**: bedrock is still one-shot (no tool loop). If agents
  must run on Bedrock with tools, that adapter needs a converse tool loop —
  out of scope here but flagged.
- **Model id namespacing**: OpenRouter uses `vendor/model`; pricing now strips
  that, but role-default columns assume bare ids. Decide whether `openaiModel`
  defaults should carry routing prefixes when a preset is active.
