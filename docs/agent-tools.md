# Agent tool surface

Anchorage's reasoning agents (`planner`, `coder`, `reviewer`, `issue-triage`) acquire context by calling tools through a provider-agnostic tool-use loop. This document describes the surface, the budgets, and the capability gates.

> Background: [ADR 0024 — Agents acquire context through a uniform tool surface](../../anchorage-internal/adr/0024-agent-context-via-uniform-tool-surface.md).

## Loop

`@anchorage/agent-llm` exposes:

```ts
import { runWithTools, providerFromLlmConfig, repoReadTools, webTools, shellTools, discoveryTools, repoWriteTools } from "@anchorage/agent-llm";

const provider = providerFromLlmConfig(llmConfig).value;
const result = await runWithTools(provider, {
  system,
  messages: [{ role: "user", content: userPrompt }],
  tools: [...discoveryTools, ...repoReadTools, ...webTools, ...shellTools, ...repoWriteTools],
  workspacePath,
  capabilities: new Set(task.capabilities),
  env: process.env,
  onEvent: (event) => writeToProtocolStream(event),
});
```

The loop drives `model → tool calls → model → ...` until the model returns a terminal message (no `tool_use` blocks) or a budget is exhausted. Each tool dispatch emits exactly one `tool.requested` event and one `tool.result` event on the protocol stream.

## Tools

| Tool | Capability | Bounds |
|---|---|---|
| `read_file(path, [line_range])` | `repo.read` | 100 KB / call; path-sandboxed to workspace |
| `list_dir([path], [glob], [max_entries])` | `repo.read` | git-tracked + untracked-not-ignored; 200 entries default |
| `grep(pattern, [path], [include_glob], [max_matches])` | `repo.read` | 50 matches default |
| `git_log(path, [since], [max_commits])` | `repo.read` | 90 days, 10 commits default |
| `git_show(sha, [path])` | `repo.read` | 300 KB stdout cap |
| `git_diff(ref_a, ref_b, [path])` | `repo.read` | 300 KB stdout cap |
| `detect_project()` | `repo.read` | Inspects manifests, reports language/test/build/lint |
| `read_repo_manifest()` | `repo.read` | Returns `AGENTS.md` / `CLAUDE.md` / `.anchorage/context.md` if present; no error on absence |
| `find_references(symbol, [path])` | `repo.read` | tree-sitter per-call scan; 40 candidate files / 80 refs; fails closed to grep |
| `symbol_outline(path)` | `repo.read` | tree-sitter; definitions in one file; fails closed to read_file |
| `impact(symbol)` | `repo.read` | cartographer persisted index: defs, refs, transitive dependents (crosses barrels/workspace packages), covering tests; fails closed to find_references |
| `tests_for(path)` | `repo.read` | cartographer index: tests importing the file (transitively) + name-mirrored; fails closed |
| `repo_map([max_results])` | `repo.read` | local import-in-degree ranking of source files + their top symbols; one-call orientation; 40 files default; fails closed |
| `write_file(path, content)` | `workspace.write` | 1 MB content cap; full-file replace |
| `delete_file(path)` | `workspace.write` | — |
| `shell_exec(command, [cwd], [timeout_ms])` | `shell.exec` | 60s default / 600s cap; stdout 100 KB / stderr 16 KB; scrubbed env |
| `web_search(query, [max_results])` | `web.read` | Tavily → Brave → DuckDuckGo HTML, 10 results max |
| `web_fetch(url)` | `web.read` | HTTPS only; text/json/xml only; 1 MB cap; 5 redirects |
| `github_search_issues(owner, repo, query)` | `web.read` | 10 results; uses `GH_TOKEN` if present |
| `github_get_file(owner, repo, path, [ref])` | `web.read` | 1 MB cap |

Tools without their declared capability in `task.capabilities[]` are silently dropped from the catalog the model sees — there is no way for the model to call a tool it has not been granted.

## Budgets

All budgets are enforced inside `runWithTools` and can be tuned per-run with env vars:

| Env | Default | Effect |
|---|---|---|
| `ANCHORAGE_TOOL_MAX_TURNS` | 30 | Total LLM→tool turns per agent run |
| `ANCHORAGE_TOOL_MAX_INPUT_TOKENS` | 200 000 | Rolling input-token total |
| `ANCHORAGE_TOOL_MAX_FILES` | 50 | Unique workspace files read |
| `ANCHORAGE_TOOL_MAX_WEB_CALLS` | 10 | `web_search` + `web_fetch` + GitHub-API calls |
| `ANCHORAGE_TOOL_MAX_SHELL_CALLS` | 20 | `shell_exec` invocations |
| `ANCHORAGE_TOOL_WEB_ENABLED` | `false` | Master switch for web tools |
| `ANCHORAGE_SHELL_ENV_PASSTHROUGH` | (empty) | Comma-separated extra env names allowed into `shell_exec` |
| `ANCHORAGE_TOOL_SYMBOLS_ENABLED` | `true` | Master switch for `find_references` / `symbol_outline` |
| `ANCHORAGE_TOOL_CARTOGRAPHER_ENABLED` | `true` | Master switch for `impact` / `tests_for` |
| `ANCHORAGE_CARTOGRAPHER_BIN` | (empty) | Path to the cartographer CLI (a `.js` entry runs under node); unset falls back to `cartographer` on PATH, and a missing binary just fails the tools closed |
| `ANCHORAGE_LLM_PROMPT_CACHE` | `true` | Prompt caching: Anthropic caches system + tool catalog + the per-turn conversation prefix; Bedrock inserts Converse `cachePoint` blocks (transparently dropped on models that reject them). Lossless. |
| `ANCHORAGE_TOOL_DEDUP` | `true` | Collapse a tool result that is byte-for-byte identical to an earlier one this run into a back-reference (≥500 B, successful string outputs). The original stays in context once — lossless. |
| `ANCHORAGE_SHELL_CLEAN` | `true` | Strip terminal control noise (ANSI codes, carriage-return progress frames, blank-line runs, trailing whitespace) from `shell_exec` output before the model sees it. Lossless. |
| `ANCHORAGE_TOOL_CONTEXT_NUDGE` | `true` | When a context-miss signal fires (repeated grep, grep→read churn, file-read cap), append a one-time guidance note to that tool result steering the model to `find_references` / `impact` / `repo_map`. Additive guidance only — lossless. Fired nudges are reported in `snapshot.contextNudges`. |
| `ANCHORAGE_TOOL_CONTEXT_ENFORCE` | `false` | **Aggressive, opt-in.** Refuse a `grep` that repeats a pattern already searched this run (returns an error steering to `find_references`/`impact`). Off by default because it can block a legitimate re-grep. |

Hitting any budget produces a `RunWithToolsResult` with `ok: false`, `code: "budget_exceeded"`, and a `reason` enum identifying the cap that fired. Agents surface this as `agent.failed` with `code: "tool_budget_exceeded"`.

## Capability gating

Each agent's `agent.json` declares the capabilities it relies on:

| Agent | `requires` |
|---|---|
| `planner` | `llm.plan`, `repo.read`, `web.read` |
| `coder` | `workspace.write`, `llm.code`, `shell.exec`, `repo.read`, `web.read` |
| `reviewer` | `github.read`, `llm.review`, `repo.read`, `web.read` |
| `issue-triage` | `llm.plan`, `repo.read`, `web.read` |

The orchestrator can deny capabilities per run (e.g. strip `web.read` for cost-sensitive sandboxes, strip `shell.exec` for review-only runs). The agent simply sees a smaller tool catalog.

## Telemetry

- Every tool call emits a `tool.requested` and a `tool.result` protocol event with the existing schema — no protocol change needed.
- Each agent emits one `agent.progress` event near completion with `data: { kind: "context.snapshot", bytesAcquired, filesRead, toolTurns, webCalls, shellCalls, inputTokensTotal, outputTokensTotal }` for run-level instrumentation.
- The orchestrator's OTel pipeline (ADR 0023) annotates these events with `correlationId` / `runId` / `taskId` and exports them to OpenObserve. Tool latency, success, and output size are all queryable in SQL.

## Prompt-injection posture

- Every tool result is delivered as a `tool_result` block (Anthropic) or `tool` role message (OpenAI), never concatenated into the system prompt.
- System prompts explicitly instruct the model to treat tool output (file contents, web pages, issue bodies) as **data**, not commands.
- `repo.write` and `shell.exec` are gated; agents lacking those capabilities cannot have their tool output redirected into destructive actions.
- All tool calls — including their input and a preview of their output — are emitted to the protocol stream and stored in OpenObserve. Every action is auditable.

## Provider portability

`providerFromLlmConfig(llmConfig)` selects an adapter from the existing `LlmConfig` resolver:

| Provider | Adapter | Status |
|---|---|---|
| Anthropic | `createAnthropicProvider` | Default; tool_use native |
| OpenAI | `createOpenAiProvider` | Function calling; default for GPT-class models |
| Moonshot / Kimi | `createOpenAiProvider` | OpenAI-compatible; same loop |
| openai-compatible gateways | `createOpenAiProvider` | OpenAI-compatible; same loop |
| AWS Bedrock | — | Blocked: account-level `NOT_AUTHORIZED`; Converse-API support lands when access does |

## See also

- ADR 0024 — design rationale and alternatives considered
- `agents/planner/src/index.ts:driveCoderLoop`-equivalent in each agent for the integration shape
- `anchorage/agents/llm/src/tools/` for the implementation
