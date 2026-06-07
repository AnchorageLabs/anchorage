# CHANGELOG — AnchorageLabs/anchorage

All substantive changes to this repo are recorded here. Format derived from Keep a Changelog, adapted for AnchorageLabs build discipline.

> **Required for every substantive PR.** Append entries with `bin/changelog-append.sh` (run from this repo). Do not edit history once a release is cut.

## Entry format

```
### YYYY-MM-DD — <one-line intent>

**Intent:** <outcome language; what changes for users / the system, not what code moved>

**Files touched:**
- path/to/file.ts
- path/to/other.md

**Reason:** <issue #N / ADR-NNN / runbook / incident date / written constraint>

**Author:** <git user.name>
```

**Hard rules:**
- No AI co-authors (no `Claude`, `Codex`, `GPT-*`). Authorship is human.
- Reason must cite a source — never just "cleanup" or "refactor".
- Entries are committed alongside the change they describe.

---

## [unreleased]

### 2026-06-07 — Reviewer emits revision requests; merge-gate skips gracefully; pr-opener is idempotent — enabling an auto-fix review loop.

**Intent:** A reviewer "request_changes" can now be fixed automatically. The reviewer emits a code.revision.request (alongside pr.review.result) so a reviewer → coder feedback loop can hand the findings back to the coder; it still exits 0. When the loop can't get an approval, the merge-gate now SKIPS the merge gracefully (run completes, merged:false/skipped:true, PR left open with feedback) instead of failing the run with PolicyDenied. pr-opener is now idempotent — on a 422 it reuses the existing open PR for the branch, which is required because the loop re-runs pr-opener after the PR already exists.

**Files touched:**
- agents/reviewer/src/index.ts
- agents/merge-gate/src/index.ts
- agents/pr-opener/src/index.ts

**Reason:** planning-2026-06-06.md §6 (Agent Feedback) — close the reviewer dead-end into an auto-fix loop; user request to make a non-approve skip the merge gracefully rather than fail the run.

**Author:** Sol Soletti

### 2026-06-07 — Fix merge-gate review check so a reviewer "request_changes" actually cancels the merge with correct guidance.

**Intent:** When the reviewer concludes request_changes, the merge-gate cancels the merge (PolicyDenied) and the PR stays open with the reviewer's feedback. The non-approve block already prevented the merge, but it compared the decision against "changes_requested" — a value the reviewer never emits (it emits "approve" | "request_changes") — so the changes-requested-specific guidance was dead code. Corrected the value and made the "merge cancelled" intent explicit in the failure message.

**Files touched:**
- agents/merge-gate/src/index.ts

**Reason:** Reviewer/merge-gate decision-value mismatch surfaced while validating run_srv_1780803022653_22 (reviewer emitted request_changes).

**Author:** Sol Soletti

### 2026-06-07 — Add code.revision.request artifact so the tester can hand failures back to the coder.

**Intent:** A failing test/typecheck no longer just ends the pipeline — the tester now emits a structured `code.revision.request` artifact describing what failed, and the coder reads it on a loop-back to fix the listed failures instead of starting over. Introduces a shared SDK type so emitter and consumer cannot drift on field names. (Orchestrator side wires the actual loop.)

**Files touched:**
- sdk/typescript/src/artifacts.ts
- sdk/typescript/src/index.ts
- sdk/typescript/tests/artifacts.test.ts
- agents/tester/src/index.ts
- agents/coder/src/index.ts

**Reason:** ADR-0029 / planning-2026-06-06.md §6 (Agent Feedback) — close the forward-only pipeline into a real feedback loop with a first-class revision-request artifact.

**Author:** Sol Soletti
### 2026-06-07 — Add tree-sitter symbol tools (find_references, symbol_outline) to the repo.read surface.

**Intent:** Give the reasoning agents symbol-level awareness alongside grep. Two new tools on the existing `repo.read` capability — `find_references(symbol, [path])` (definition + reference `file:line`s, to gauge a change's blast radius) and `symbol_outline(path)` (a file's defined symbols) — backed by a tree-sitter engine (`web-tree-sitter` + `tree-sitter-wasms`, 36 languages). Tool descriptions steer selection: `grep` now defers named-symbol lookups to `find_references`, and the symbol tools are marked "preferred" for symbol/structure queries — without this, weaker models (e.g. Haiku) default to grep and never reach for them. Additive and uncapped: they sit next to `grep`/`read_file` and the model uses whichever fits; grep is never replaced or limited. Fidelity is syntactic (accurate definitions, identifier-matched references — not type-resolved), and every path **fails closed** to a plain note (unsupported language, missing grammar, oversized file, parse error) so the model falls back to grep with no failure path. A `git grep -l` prefilter bounds which files tree-sitter parses; candidate/result caps bound cost. Tools ride the existing `repo.read` gate, so planner/coder/reviewer/issue-triage gain them automatically; `ANCHORAGE_TOOL_SYMBOLS_ENABLED=false` is an ops kill-switch (default on). Symbol-tool usage is observable via the existing `tool.requested`/`tool.result` events — no protocol change.

**Files touched:**
- agents/llm/src/tools/symbols/engine.ts
- agents/llm/src/tools/builtin/symbols.ts
- agents/llm/src/tools/builtin/repo.ts
- agents/llm/src/index.ts
- agents/llm/package.json
- pnpm-lock.yaml
- CHANGELOG.md

**Reason:** anchorage-internal#31 — symbol tool from the agent-context audit (anchorage-internal#28).

**Author:** Valentin Torassa

### 2026-06-07 — Emit context-miss telemetry on the tool-loop snapshot.

**Intent:** The `context.snapshot` event now carries three context-miss signals — `filesReadCapHit`, `repeatedSymbolGrep`, `grepReadChurn` — so we can measure across real runs how often agents are under-served by the lexical tool surface (grep / read_file). Measurement only: no tool is capped or limited, grep stays uncapped, and the loop's behaviour is unchanged.

**Files touched:**
- agents/llm/src/tools/types.ts
- agents/llm/src/tools/loop.ts

**Reason:** anchorage-internal#30 — telemetry for the symbol-tool A/B (anchorage-internal#28)

**Author:** Valentin Torassa
### 2026-06-07 — Fix biome formatting drift on main (CI lint red).

**Intent:** `biome check .` was failing on `main` (3 errors) because `agents/coder/src/index.ts` and `agents/issue-opener/src/index.ts` were committed without biome 2.4.15 formatting — long lines not wrapped and one unsorted import group. Applied `biome check --write` (formatting/import-organization only, no behaviour change) so CI lint is green again and dependent PRs can merge.

**Files touched:**
- agents/coder/src/index.ts
- agents/issue-opener/src/index.ts

**Reason:** CI "Build and Test" → lint step red on main; blocks all open PRs.

**Author:** Valentin Torassa
### 2026-06-07 — Feed coder full issue context; migrate issue-opener to runWithTools; document Bedrock as one-shot only.

**Intent:** Feed coder full issue context; migrate issue-opener to runWithTools; document Bedrock as one-shot only.

**Files touched:**
- agents/coder/src/index.ts
- agents/issue-opener/src/index.ts
- agents/llm/src/index.ts

**Reason:** planning-2026-06-06.md items 5, 2, 3-B: coder was ignoring issue.summary and triage.result already in priorArtifacts; issue-opener had a bespoke ReAct loop inconsistent with the rest of the tool-using agents; Bedrock tool-loop error message was misleading.

**Author:** Sol Soletti

### 2026-06-06 — Planner/coder reuse existing types; coder gates on tests + typecheck; reviewer checks integration.

**Intent:** Raise output quality of the reasoning agents after chary#18 shipped code that didn't integrate (it invented a parallel `ParsedCommit` with `hash` instead of reusing the repo's `Commit` with `sha`, and shipped self-referential tests). Prompt-level hardening:
- **planner:** must grep for and reuse existing types/contracts (never a parallel type for an existing concept; call out real field names); `acceptanceCriteria` must require the repo's real test suite + typecheck/build to pass and at least one integration test against the real upstream types, with runnable `verificationCommands` for both.
- **coder:** reuse existing contracts (no look-alike types / field mismatches); MUST run the repo's tests + typecheck via `shell_exec` and they MUST pass before finishing — never report success over a red state; cover the change with an integration test against real types.
- **reviewer:** explicitly flags duplicate/parallel types (e.g. `hash` vs `sha`), code that can't be fed by its real upstream producer, committed `node_modules/`/`dist/`, and self-referential tests (request a real integration test).

These pair with the new `issue-to-reviewer` workflow (anchorage-orchestrator) which adds the tester + reviewer gates.

**Files touched:**
- agents/planner/src/index.ts
- agents/coder/src/index.ts
- agents/reviewer/src/index.ts
- CHANGELOG.md

**Reason:** chary#18 — agentic output didn't reuse existing types, had no integration test, and wasn't gated on tests/typecheck.

**Author:** Sol Soletti

### 2026-06-06 — Coder never commits node_modules / build output.

**Intent:** Stop the coder from committing dependency installs and build artifacts. It may run `pnpm install` / a build via `shell_exec`, producing `node_modules/` and `dist/`; combined with `git add -A` and a target repo that has no `.gitignore`, this swept everything into the commit (chary#18 opened a PR with ~1.28M lines across ~4.5k files). The coder now (1) writes a baseline `.gitignore` when the workspace has none, and (2) passes pathspec excludes to `git add` for `node_modules`, `dist`, `build`, `out`, `.next`, `coverage`, `target`, etc. — so artifacts are never staged even when an existing `.gitignore` is incomplete. The committed diff / `code.change.result` artifact stay clean as a result.

**Files touched:**
- agents/coder/src/index.ts
- CHANGELOG.md

**Reason:** `git add -A` in the coder committed `node_modules`/`dist` on repos without a `.gitignore`.

**Author:** Sol Soletti

### 2026-06-06 — Bound tool input echoed into tool.requested events.

**Intent:** Cap the serialized tool input carried in `tool.requested` protocol events (preview beyond ~4KB) in `@anchorage/agent-llm`. A large argument — e.g. the coder calling `write_file` with a big file body — previously produced a multi-hundred-KB NDJSON event line; when that line was truncated/mis-framed the strict event-stream parser failed the whole run with `runner_preflight_failed` ("invalid JSON"). `tool.result` already truncated to a preview; this makes `tool.requested` symmetric. The tool handler still receives the full, untouched input — only the observability event is bounded. Surfaced once tool budgets were uncapped and the coder began reaching large `write_file` calls.

**Files touched:**
- agents/llm/src/tools/loop.ts
- CHANGELOG.md

**Reason:** Oversized `tool.requested` event lines aborted real coder runs at the runner's NDJSON validation.

**Author:** Sol Soletti

### 2026-06-06 — Tool loop runs uncapped by default; budgets become opt-in via env.

**Intent:** Remove the default tool-loop budget caps in `@anchorage/agent-llm`. Max turns, input tokens, files, web calls, and shell calls are now **unlimited by default**, so the reasoning agents (planner/coder/reviewer/issue-triage/issue-opener) run their tool loop to completion instead of aborting at 30 turns with `tool_budget_exceeded`. Each limit stays configurable per run via `ANCHORAGE_TOOL_MAX_*` — a positive number sets a cap, `0` or negative means unlimited, unset uses the (now-unlimited) default. The orchestrator's Temporal activity timeout (start-to-close / heartbeat) remains the hard backstop against runaway loops.

**Files touched:**
- agents/llm/src/tools/types.ts
- agents/llm/src/tools/budget.ts
- CHANGELOG.md

**Reason:** The 30-turn cap aborted real issue→PR runs (`tool_budget_exceeded`) before the coder finished.

**Author:** Sol Soletti

### 2026-06-06 — Narrow the LLM adapter to Anthropic, OpenAI, and Bedrock with full tool-loop parity.

**Intent:** Trim `@anchorage/agent-llm` to three providers — `anthropic`, `openai`, `aws-bedrock` — and remove `moonshot`, `kimi`, and the generic `openai-compatible` paths along with their `ANCHORAGE_LLM_API_KEY`/`ANCHORAGE_LLM_BASE_URL` credentials. Provider selection stays a single env switch (`ANCHORAGE_LLM_PROVIDER`, inferred from `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` → AWS credentials when unset) and model selection stays `ANCHORAGE_<ROLE>_MODEL` → `ANCHORAGE_LLM_MODEL` → per-provider default, so swapping providers or model tiers is env-only.

All three providers now drive the multi-turn tool loop. Bedrock gains a Converse-API `ProviderAdapter` with native `toolConfig` tool use — previously `providerFromLlmConfig` hard-errored for Bedrock, so only the one-shot path worked there. Every flow now tolerates models that drop request parameters: the Anthropic and OpenAI tool-loop adapters retry without `temperature` (Opus 4.7/4.8 reject it) and flex `max_completion_tokens`↔`max_tokens` (OpenAI reasoning models), matching the one-shot path. Shared "is this param rejected" predicates live in a new `param-support` module used by both paths.

**Files touched:**
- agents/llm/src/index.ts
- agents/llm/src/tools/providers/param-support.ts
- agents/llm/src/tools/providers/bedrock.ts
- agents/llm/src/tools/providers/anthropic.ts
- agents/llm/src/tools/providers/openai.ts
- agents/llm/README.md
- CHANGELOG.md

**Reason:** Anthropic-first cost control with predictable, env-only provider/model switching; unblock Bedrock tool use and Opus 4.8 parameter compatibility across every agent.

**Author:** Sol Soletti

### 2026-06-04 — Agents acquire context through a uniform tool surface.

**Intent:** Replace the planner/coder/reviewer/issue-triage one-shot LLM calls with a provider-agnostic tool-use loop in `@anchorage/agent-llm`. Agents now actively read the workspace (read_file/list_dir/grep/git_log/git_show/git_diff/detect_project/read_repo_manifest), write changes (write_file/delete_file), run verification commands (shell_exec), and consult the open web (web_search/web_fetch/github_search_issues/github_get_file) via capability-gated tools. Removes the ≤12-file pre-load in the coder and the "no repo visibility" blind spot in the planner and reviewer. No protocol changes — tool calls ride existing `tool.requested`/`tool.result` events; per-run `agent.progress` carries a `context.snapshot` payload with bytes/files/turns/tokens.

After live verification against AnchorageLabs/chary#6 (issue → PR #13), strict-JSON output is enforced on every reasoning agent (no markdown fences, no thinking tags) and the JSON extractor uses balanced-brace scanning that survives the cases models sometimes slip in.

**Files touched:**
- anchorage-internal/adr/0024-agent-context-via-uniform-tool-surface.md
- agents/llm/src/index.ts
- agents/llm/src/tools/types.ts
- agents/llm/src/tools/budget.ts
- agents/llm/src/tools/registry.ts
- agents/llm/src/tools/loop.ts
- agents/llm/src/tools/builtin/repo.ts
- agents/llm/src/tools/builtin/discovery.ts
- agents/llm/src/tools/builtin/shell.ts
- agents/llm/src/tools/builtin/web.ts
- agents/llm/src/tools/providers/anthropic.ts
- agents/llm/src/tools/providers/openai.ts
- agents/llm/scripts/smoke-tool-loop.mjs
- agents/planner/src/index.ts
- agents/planner/agent.json
- agents/coder/src/index.ts
- agents/coder/agent.json
- agents/reviewer/src/index.ts
- agents/reviewer/agent.json
- agents/issue-triage/src/index.ts
- agents/issue-triage/agent.json
- docs/agent-tools.md
- CHANGELOG.md

**Reason:** ADR-0024.

**Author:** Valentin Torassa

### 2026-06-04 — Add issue-opener reference agent for instruction → issue.

**Intent:** Add a public `issue-opener` agent that turns a natural-language instruction into a detailed GitHub issue. It supports the new `issue.open` task type, explores the repository with a bounded, provider-portable ReAct loop over the shared LLM adapter (the model emits one JSON action per turn — `list_dir`/`read_file`/`search`/`finalize` — so no native tool-calling is required), path-guarded to read only inside `workspacePath`, then creates the issue via the GitHub API. It emits `issue.opened` (record) plus `issue.summary` in the same shape `issue-reader` produces, so downstream agents consume it directly. `issue-closer` now falls back to the `issue.opened`/`issue.summary` artifact for the issue number when it is created mid-run.

**Files touched:**
- CHANGELOG.md
- agents/README.md
- agents/issue-opener/agent.json
- agents/issue-opener/package.json
- agents/issue-opener/tsconfig.json
- agents/issue-opener/src/index.ts
- agents/issue-opener/README.md
- agents/issue-closer/src/index.ts
- pnpm-lock.yaml

**Reason:** ADR-0023 — instruction-driven pipeline entry. The pipeline could only start from an existing issue; this bridges natural language to a grounded, code-aware issue.

### 2026-06-04 — Coder captures the change diff so the UI can render it.

**Intent:** After applying changes the coder captures the staged unified diff (`git diff --cached`) in its own workspace and embeds it in the `code.change.result` artifact as a raw `diff` plus a per-file `fileDiffs` breakdown. Consumers (the orchestrator diff endpoint and the test-UI Changes tab) can render the real change set without re-running git in a workspace that may not hold the branch or commit. The diff is captured even when commit/push degrades, so the change stays reviewable.

**Files touched:**
- CHANGELOG.md
- agents/coder/src/index.ts

**Reason:** Test-UI Changes tab showed nothing because the branch diff (issue #47) was recomputed server-side against a workspace that often lacked the branch.

**Author:** Sol Soletti

### 2026-06-01 — Start coder branches from the selected remote base.

**Intent:** Ensure the coder resolves each issue from the selected base branch (`main` or the branch chosen in the UI) by fetching and fast-forward pulling it from origin before creating the issue branch. The coder also expands directory `likelyFiles` entries (for example `api/` and `api/internal/`) into tracked source files so broad API issues do not collapse into `status: no_changes` because only `api/go.mod` and docs were provided as context. PR opening can recover when the coder created a commit but reported `pushed: false` by publishing that existing branch as a recovery step.

**Files touched:**
- CHANGELOG.md
- agents/coder/src/index.ts
- agents/pr-opener/src/index.ts

**Reason:** Live pipeline against `AnchorageLabs/envy#34` failed at `pr-opener` with `branch_not_pushed`, but the real upstream failure was in the coder path: it created the issue branch from whatever checkout the workspace currently had and produced `status=no_changes`, `pushSkippedReason=no_changes`, with a summary saying the selected context only contained `api/go.mod` and `docs/MODEL.md` while the change required router/auth/handler/store/db/migration files. CodeGraph traced the flow through `commitAndPush`, `parseCodeChangeResult`, and `runDefinition`; run artifacts confirmed the coder never produced a commit to publish.

**Author:** Sol Soletti


### 2026-05-13 — Restore green CI baseline for current Dependabot action PRs.

**Intent:** Let current GitHub Actions dependency updates validate against a green baseline by fixing Biome lint drift and making Vitest resolve a peer-compatible Vite version during SDK tests.

**Files touched:**
- CHANGELOG.md
- agents/issue-reader/src/index.ts
- agents/issue-triage/src/index.ts
- agents/merge-gate/src/index.ts
- package.json
- pnpm-lock.yaml

**Reason:** Dependabot PRs #84-#87 were blocked on stale red CI; ADR-0020.

**Author:** Valentin Torassa

### 2026-05-10 — pr-opener recovers from non-fast-forward push rejections via fetch + rebase.

**Intent:** Let pr-opener finish the workflow when the remote branch has commits the agent does not (typical when a prior run wrote to the same `feat/*` branch). On a `[rejected] (fetch first|non-fast-forward)` response, fetch the remote ref, rebase the local commit on top, and retry the push once. Abort with a clear `git_rebase_conflict` failure on real conflicts so humans can resolve — no silent force-push.

**Files touched:**
- CHANGELOG.md
- agents/pr-opener/src/index.ts

**Reason:** Observed on `AnchorageLabs/chary#2` during a live run on 2026-05-10 — pr-opener emitted `git_push_failed` with `! [rejected] feat/git-adapter -> feat/git-adapter (fetch first)` and aborted the workflow before opening the PR.

**Author:** Valentin Torassa

### 2026-05-10 — Fix GitHub token fallback so empty env vars do not block agents.

**Intent:** Allow agents to fall back to `GH_TOKEN` (or `GITHUB_TOKEN`) when the primary variable is forwarded as an empty string by the orchestrator's docker-compose, instead of treating empty as "set" and failing with `missing_github_token`.

**Files touched:**
- CHANGELOG.md
- agents/ci-watcher/src/index.ts
- agents/issue-closer/src/index.ts
- agents/issue-reader/src/index.ts
- agents/issue-triage/src/index.ts
- agents/merge-gate/src/index.ts
- agents/planner/src/index.ts
- agents/pr-opener/src/index.ts
- agents/reviewer/src/index.ts
- agents/tester/src/index.ts

**Reason:** Live OpenAI run on 2026-05-10 (`run_srv_1778428099606_17` against `AnchorageLabs/envy#17`) failed at `read-issue` because `docker-compose.yml` forwards `GITHUB_TOKEN: "${GITHUB_TOKEN:-}"` as `""` when only `GH_TOKEN` is set in `.env`. JavaScript's `??` short-circuits only on `null`/`undefined`, so the agents never reached the `GH_TOKEN` fallback. Switching to `||` matches the documented operator precedence and the intent of the fallback chain.

**Author:** Valentin Torassa

### 2026-05-10 — Fix LLM adapter env-var fallbacks so empty strings do not break baseUrl resolution.

**Intent:** Allow the shared LLM adapter to fall back to the next variable in each provider chain (API key, baseUrl, region, model) when the primary variable is forwarded as an empty string by the orchestrator's docker-compose, instead of treating empty as "set" and producing `baseUrl=""` (which makes `fetch("/chat/completions")` throw `Failed to parse URL`).

**Files touched:**
- CHANGELOG.md
- agents/llm/src/index.ts

**Reason:** Live OpenAI run on 2026-05-10 (`run_srv_1778428099606_17` against `AnchorageLabs/envy#17`) failed at `create-plan` with `Failed to parse URL from /chat/completions` because `OPENAI_BASE_URL=""` was forwarded by docker-compose and `??` short-circuited on it instead of falling through to the next candidate. Same root-cause class as the agent token fallback fix in the same release.

**Author:** Valentin Torassa

### 2026-05-10 — Keep the LLM adapter explicit about runtime globals.

**Intent:** Let dev-dependency updates validate cleanly by making the shared LLM adapter declare its Node and fetch runtime globals explicitly instead of relying on TypeScript's ambient type inference.

**Files touched:**
- CHANGELOG.md
- agents/llm/tsconfig.json

**Reason:** Dependabot PR #74 failed after TypeScript/@types updates because `agents/llm` did not explicitly declare Node and fetch globals.

**Author:** Valentin Torassa

### 2026-05-10 — Restore CI for Dependabot dependency updates.

**Intent:** Keep automated dependency updates mergeable by formatting the v0 integration fixtures and agent sources, fixing the shared LLM adapter type errors, and making the Docker build include the root TypeScript config plus all built agent packages.

**Files touched:**
- CHANGELOG.md
- Dockerfile
- agents/coder/src/index.ts
- agents/issue-closer/src/index.ts
- agents/issue-reader/src/index.ts
- agents/issue-triage/src/index.ts
- agents/llm/src/index.ts
- agents/pr-opener/src/index.ts
- protocol/test-cases/integration/envelopes/01-issue-read.json
- protocol/test-cases/integration/envelopes/02-plan-create.json
- protocol/test-cases/integration/envelopes/03-code-change.json
- protocol/test-cases/integration/envelopes/04-test-run.json
- protocol/test-cases/integration/envelopes/05-pr-open.json
- protocol/test-cases/integration/envelopes/06-ci-watch.json
- protocol/test-cases/integration/envelopes/07-review-run.json
- protocol/test-cases/integration/envelopes/08-merge-prepare.json
- protocol/test-cases/integration/envelopes/09-issue-close.json
- sdk/typescript/tests/integration.test.ts

**Reason:** Dependabot PRs #69-#76 all failed CI on formatting and Docker build checks; ADR-0020.

**Author:** Valentin Torassa

### 2026-05-10 — Add provider-portable LLM adapter for reference agents.

**Intent:** Let the LLM-backed planner, coder, and reviewer run against direct Anthropic, OpenAI, OpenAI-compatible, Kimi/Moonshot, or Bedrock credentials through one shared adapter instead of hard-wiring each agent to Bedrock. Preserves the coder retry loop and `max_tokens` truncation handling introduced in #59.

**Files touched:**
- CHANGELOG.md
- agents/README.md
- agents/llm/README.md
- agents/llm/package.json
- agents/llm/src/index.ts
- agents/llm/tsconfig.json
- agents/planner/package.json
- agents/planner/src/index.ts
- agents/coder/agent.json
- agents/coder/package.json
- agents/coder/src/index.ts
- agents/reviewer/agent.json
- agents/reviewer/package.json
- agents/reviewer/src/index.ts
- pnpm-lock.yaml

**Reason:** ADR-0014; validated end-to-end on AnchorageLabs/envy#18 with OpenAI gpt-4.1 (envy PR #20, merged 2026-05-10)

**Author:** Valentin Torassa

### 2026-05-09 — v0 stabilization: docs, spec, and four agent fixes.

**Intent:** Bring docs and the protocol spec up to date with the completed v0 agent surface, and fix four behavioral issues that would break unattended pipeline retries: coder leaving dirty workspaces on failure, pr-opener committing without checking workspace cleanliness, merge-gate blocking silently on `changes_requested`, and issue-reader proceeding blindly on closed issues.

**Files touched:**
- CHANGELOG.md
- AGENTS.md
- protocol/SPEC.md
- agents/coder/src/index.ts
- agents/issue-reader/src/index.ts
- agents/pr-opener/src/index.ts
- agents/merge-gate/src/index.ts

**Reason:** post-v0 stabilization pass — observed failure modes during envy#9, #10, #13 pipeline runs

**Author:** Valentin Torassa

### 2026-05-09 — Add issue-triage reference agent for issue.triage.

**Intent:** Complete strict coverage of the standard v0.1 lifecycle task types by adding a public reference `issue-triage` agent that classifies scope, type, priority, readiness, and agent-eligibility of an issue via Bedrock and optionally applies GitHub labels.

**Files touched:**
- CHANGELOG.md
- agents/README.md
- agents/issue-triage/agent.json
- agents/issue-triage/package.json
- agents/issue-triage/tsconfig.json
- agents/issue-triage/src/index.ts
- agents/issue-triage/README.md
- examples/README.md
- examples/tasks/issue-triage.json

**Reason:** issue #51

**Author:** Valentin Torassa

### 2026-05-09 — Add GitHub comment outputs to planner and tester.

**Intent:** Let planner and tester post structured GitHub comments so GitHub acts as the v0 workflow UI. Planner posts a plan summary to the source issue; tester posts a test result table to the source issue. Both writes are capability-gated on `github.write` and non-fatal on failure.

**Files touched:**
- CHANGELOG.md
- agents/planner/package.json
- agents/planner/src/index.ts
- agents/tester/package.json
- agents/tester/src/index.ts

**Reason:** issue #49

**Author:** Sol Soletti

### 2026-05-09 — Add reproducible manual v0 pipeline recipe.

**Intent:** Give maintainers and contributors a single copy-pasteable document that reproduces the full public reference-agent pipeline end-to-end against a sandbox issue without the private orchestrator.

**Files touched:**
- CHANGELOG.md
- docs/manual-pipeline.md

**Reason:** issue #54

**Author:** Sol Soletti

### 2026-05-09 — Add integration fixtures and tests for the reference agent chain.

**Intent:** Give contributors a single deterministic command to validate protocol handoffs across the full reference-agent chain without requiring external APIs, GitHub tokens, or Bedrock credentials.

**Files touched:**
- CHANGELOG.md
- protocol/test-cases/integration/envelopes/01-issue-read.json
- protocol/test-cases/integration/envelopes/02-plan-create.json
- protocol/test-cases/integration/envelopes/03-code-change.json
- protocol/test-cases/integration/envelopes/04-test-run.json
- protocol/test-cases/integration/envelopes/05-pr-open.json
- protocol/test-cases/integration/envelopes/06-ci-watch.json
- protocol/test-cases/integration/envelopes/07-review-run.json
- protocol/test-cases/integration/envelopes/08-merge-prepare.json
- protocol/test-cases/integration/envelopes/09-issue-close.json
- sdk/typescript/tests/integration.test.ts

**Reason:** issue #50

**Author:** Valentin Torassa
### 2026-05-09 — pr-opener generates PR title and body via LLM.

**Intent:** Replace static title/body derivation in pr-opener with a Bedrock LLM call that reads the implementation plan and code-change context to produce a concise imperative title (≤60 chars) and a structured body with Summary, Why, What, How, and Notes sections. Falls back to static derivation when Bedrock auth is unavailable.

**Files touched:**
- CHANGELOG.md
- agents/pr-opener/package.json
- agents/pr-opener/src/index.ts

**Reason:** feedback — PR titles were too verbose and body lacked Why/What/How structure

**Author:** Sol Soletti

### 2026-05-09 — Fix coder agent to handle large LLM responses.

**Intent:** Let the coder handle feature-sized issues without failing when Bedrock returns a large JSON response. Raises the default output token budget to 120 000 (overridable via `ANCHORAGE_CODER_MAX_TOKENS`), adds up to two automatic retries on malformed JSON, and fails fast with a clear message when the response is truncated at the token limit instead of surfacing a confusing JSON parse error.

**Files touched:**
- CHANGELOG.md
- agents/coder/src/index.ts

**Reason:** observed failure on issue AnchorageLabs/envy#13 — `invalid_llm_code_json` at position 36868

**Author:** Valentin Torassa

### 2026-05-09 — Add issue-closer reference agent for issue.close.

**Intent:** Complete the standard v0.1 lifecycle task types in the public reference chain by adding an `issue-closer` agent that closes the originating GitHub issue and posts a concise workflow summary comment with artifact links.

**Files touched:**
- CHANGELOG.md
- agents/README.md
- agents/issue-closer/agent.json
- agents/issue-closer/package.json
- agents/issue-closer/tsconfig.json
- agents/issue-closer/src/index.ts
- agents/issue-closer/README.md
- examples/README.md
- examples/tasks/issue-close.json

**Reason:** issue #48

**Author:** Valentin Torassa

### 2026-05-09 — Let merge-gate consume ci.report artifacts from ci-watcher.

**Intent:** Complete the `ci.watch → merge.prepare` public-agent handoff by letting `merge-gate` accept a prior `ci.report` artifact so CI observation and merge readiness compose cleanly without polling GitHub CI a second time.

**Files touched:**
- CHANGELOG.md
- agents/merge-gate/src/index.ts
- examples/README.md
- examples/tasks/merge-prepare.json

**Reason:** issue #55

**Author:** Valentin Torassa

### 2026-05-09 — Add PR title policy and structured body template to pr-opener.

**Intent:** Make generated PRs consistently reviewable by enforcing a concise title (max 72 chars, derived deterministically from the code-change summary or issue number) and a structured body with Summary, Validation, Risk, Artifacts sections and a `Closes #N` line.

**Files touched:**
- CHANGELOG.md
- agents/pr-opener/src/index.ts
- examples/tasks/pr-open.json

**Reason:** issue #33

**Author:** Sol Soletti

### 2026-05-09 — Refresh public docs for the implemented reference pipeline.

**Intent:** Make the public README, agent docs, and examples match the current runnable pre-v0 reference-agent surface instead of scaffold-era status.

**Files touched:**
- README.md
- agents/README.md
- examples/README.md
- CHANGELOG.md

**Reason:** issue #51

**Author:** Valentin Torassa

### 2026-05-09 — Add ci-watcher reference agent for CI observation.

**Intent:** Let the public agent chain observe GitHub PR checks/statuses and emit structured CI failure context without encoding orchestrator routing decisions.

**Files touched:**
- CHANGELOG.md
- agents/README.md
- agents/ci-watcher/agent.json
- agents/ci-watcher/package.json
- agents/ci-watcher/src/index.ts
- agents/ci-watcher/tsconfig.json
- examples/README.md
- examples/tasks/ci-watch.json
- pnpm-lock.yaml

**Reason:** issue #46; ADR-0011

**Author:** Valentin Torassa

### 2026-05-08 — Add tester agent for local test reports.

**Intent:** Let the public agent chain validate code changes before PR creation by running configured workspace test commands and emitting a protocol-compatible `test.report` artifact.

**Files touched:**
- CHANGELOG.md
- agents/README.md
- agents/tester/agent.json
- agents/tester/package.json
- agents/tester/src/index.ts
- agents/tester/tsconfig.json
- examples/README.md
- examples/tasks/test-run.json

**Reason:** issue #38; ADR-0007

**Author:** Valentin Torassa

### 2026-05-08 — Reject pull requests in issue-reader issue reads.

**Intent:** Prevent `issue-reader` from treating pull requests as source issues when GitHub returns a PR-shaped item from the Issues API, so downstream agents do not plan against already-merged PRs.

**Files touched:**
- CHANGELOG.md
- agents/issue-reader/src/index.ts

**Reason:** issue #40

**Author:** Valentin Torassa

### 2026-05-08 — Make pr-opener stage only code-change files.

**Intent:** Prevent local test artifacts or unrelated workspace files from being committed when `pr-opener` turns a code-change result into a pull request.

**Files touched:**
- CHANGELOG.md
- agents/pr-opener/src/index.ts

**Reason:** issue #44

**Author:** Valentin Torassa

### 2026-05-08 — Align pr-opener runtime task type with its manifest.

**Intent:** Let `pr-opener` run through the reference runner with the standard `pull_request.open` task type instead of passing manifest validation and failing inside the agent.

**Files touched:**
- CHANGELOG.md
- agents/pr-opener/src/index.ts

**Reason:** issue #42

**Author:** Valentin Torassa

### 2026-05-07 — pr-opener adds Closes #N to PR body for automatic issue closing.

**Intent:** PRs opened by the pr-opener agent now include a GitHub-idiomatic `Closes #N` reference so merging the PR automatically closes the source issue.

**Files touched:**
- CHANGELOG.md
- agents/pr-opener/src/index.ts

**Reason:** issue #30

**Author:** Sol Soletti

### 2026-05-06 — Add coder agent wrapper for implementation plans.

**Intent:** Let the local agent chain move from a planner artifact into actual workspace changes by delegating `code.change` to Bedrock Opus 4.7 and applying structured file edits.

**Files touched:**
- CHANGELOG.md
- agents/README.md
- agents/coder/agent.json
- agents/coder/package.json
- agents/coder/src/index.ts
- agents/coder/tsconfig.json
- examples/README.md
- examples/tasks/code-change.json

**Reason:** issue #19; ADR-0005

**Author:** Sol Soletti

### 2026-05-06 — Add planner agent for issue-to-plan handoff.

**Intent:** Let the local agent chain move from a read GitHub issue into a Bedrock-generated implementation plan that a future coder agent can consume without scraping prose.

**Files touched:**
- CHANGELOG.md
- agents/README.md
- agents/planner/agent.json
- agents/planner/package.json
- agents/planner/src/index.ts
- agents/planner/tsconfig.json
- examples/README.md
- examples/tasks/plan-create.json

**Reason:** issue #17; ADR-0004

**Author:** Sol Soletti

### 2026-05-07 — Auto-run issue-reader on every newly opened issue.

**Intent:** Demonstrate the trigger story end-to-end without the private orchestrator: a GitHub Actions workflow turns a real `issues.opened` event into a TaskEnvelope, runs the reference runner against it, and uploads the resulting `issue.summary` artifact and event stream as workflow artifacts.

**Files touched:**
- .github/workflows/issue-reader.yml
- CHANGELOG.md

**Reason:** issue #14

**Author:** Valentin Torassa


### 2026-05-06 — Drop the unused fake-mode branch from issue-reader.

**Intent:** Remove the deterministic stub path that #10 introduced and #11 preserved; the agent's purpose is real GitHub reads, and a second in-agent code path muddied the contract for new contributors.

**Files touched:**
- CHANGELOG.md
- agents/issue-reader/src/index.ts
- examples/README.md
- examples/tasks/issue-read.json

**Reason:** issue #12

**Author:** Valentin Torassa


### 2026-05-06 — Let issue-reader read real GitHub issues while preserving fake mode.

**Intent:** Allow the reference `issue-reader` agent to ingest real GitHub issue data through the CLI path without moving orchestration logic into the public repo.

**Files touched:**
- CHANGELOG.md
- agents/issue-reader/package.json
- agents/issue-reader/src/index.ts
- examples/tasks/issue-read.json

**Reason:** issue #8

**Author:** Sol Soletti


### 2026-05-05 — Add a local issue-reader agent slice that runs through the reference runner.

**Intent:** Prove the CLI-first protocol path with a concrete `issue.read` agent and runnable example task.

**Files touched:**
- CHANGELOG.md
- agents/issue-reader/agent.json
- agents/issue-reader/package.json
- agents/issue-reader/tsconfig.json
- agents/issue-reader/src/index.ts
- examples/README.md
- examples/tasks/issue-read.json

**Reason:** issue #4; ADR-0003

**Author:** Sol Soletti


### 2026-05-05 — Add the reference CLI runner for executing protocol-compatible agents.

**Intent:** Let users run a protocol-compatible agent locally through `anchorage run <agent> < task.json` with manifest, capability, event-stream, and exit-code validation.

**Files touched:**
- CHANGELOG.md
- cli/anchorage-runner/package.json
- cli/anchorage-runner/tsconfig.json
- cli/anchorage-runner/src/index.ts

**Reason:** issue #3; ADR-0003

**Author:** Sol Soletti


### 2026-05-05 — Tighten protocol conformance validation and neutralize flagship examples.

**Intent:** Make the machine-readable protocol contract match the prose spec and keep conformance fixtures from presenting `issue.read` as the primary Anchorage use case.

**Files touched:**
- CHANGELOG.md
- pnpm-lock.yaml
- protocol/SPEC.md
- protocol/schemas/protocol-event.schema.json
- protocol/test-cases/valid/tasks/minimal-envelope.json
- protocol/test-cases/invalid/tasks/invalid-protocol-version.json
- protocol/test-cases/invalid/tasks/missing-task-type.json
- protocol/test-cases/valid/events/agent-started.json
- protocol/test-cases/valid/events/tool-requested.json
- protocol/test-cases/valid/events/tool-result.json
- protocol/test-cases/valid/events/policy-requested.json
- protocol/test-cases/valid/events/policy-resolved.json
- protocol/test-cases/valid/events/artifact-created.json
- protocol/test-cases/valid/events/agent-completed.json
- protocol/test-cases/invalid/events/agent-failed-missing-error.json
- protocol/test-cases/invalid/events/malformed-event.json
- protocol/test-cases/invalid/events/policy-requested-missing-gate.json
- protocol/test-cases/invalid/events/policy-resolved-missing-decision.json
- protocol/test-cases/invalid/events/tool-requested-missing-tool.json
- protocol/test-cases/invalid/events/tool-result-missing-success.json
- protocol/test-cases/valid/manifests/minimal-agent.json
- protocol/test-cases/invalid/manifests/missing-binary.json
- sdk/typescript/package.json
- sdk/typescript/src/index.ts
- sdk/typescript/src/validation/validator.ts
- sdk/typescript/src/events/event-stream.ts
- sdk/typescript/tests/validation.test.ts

**Reason:** ADR-0004; post-merge review of PR #1 and ADR-0003.

**Author:** Valentin Torassa


### 2026-05-05 — Make the public protocol executable through JSON Schema test cases and TypeScript SDK validation.

**Intent:** Give agents, adapters, and future orchestrators a language-neutral protocol contract with a TypeScript validation implementation.

**Files touched:**
- package.json
- pnpm-workspace.yaml
- tsconfig.base.json
- biome.json
- protocol/SPEC.md
- protocol/package.json
- protocol/scripts/validate-test-cases.mjs
- protocol/schemas/artifact-reference.schema.json
- protocol/schemas/agent-manifest.schema.json
- protocol/schemas/protocol-event.schema.json
- protocol/schemas/task-envelope.schema.json
- protocol/test-cases/valid/tasks/issue-read.json
- protocol/test-cases/invalid/tasks/invalid-protocol-version.json
- protocol/test-cases/invalid/tasks/missing-task-type.json
- protocol/test-cases/valid/events/agent-started.json
- protocol/test-cases/valid/events/artifact-created.json
- protocol/test-cases/valid/events/agent-completed.json
- protocol/test-cases/invalid/events/malformed-event.json
- protocol/test-cases/valid/manifests/issue-reader.json
- protocol/test-cases/invalid/manifests/missing-binary.json
- sdk/typescript/package.json
- sdk/typescript/tsconfig.json
- sdk/typescript/vitest.config.ts
- sdk/typescript/src/index.ts
- sdk/typescript/src/types.ts
- sdk/typescript/src/exit-codes.ts
- sdk/typescript/src/schemas/index.ts
- sdk/typescript/src/validation/index.ts
- sdk/typescript/src/validation/validator.ts
- sdk/typescript/src/events/event-types.ts
- sdk/typescript/src/events/event-stream.ts
- sdk/typescript/tests/validation.test.ts

**Reason:** ADR-0003

**Author:** Sol Soletti


### 2026-05-04 — Bootstrap public open-core monorepo skeleton with module placeholders, license, and AGENTS/SOUL contracts.

**Intent:** Bootstrap public open-core monorepo skeleton with module placeholders, license, and AGENTS/SOUL contracts.

**Files touched:**
- AGENTS.md
- SOUL.md
- CHANGELOG.md
- README.md
- LICENSE
- .gitignore
- .githooks/prepare-commit-msg
- .githooks/commit-msg
- protocol/README.md
- sdk/typescript/README.md
- cli/anchorage-runner/README.md
- agents/README.md
- adapters/mcp/README.md
- adapters/a2a/README.md
- examples/README.md

**Reason:** Initial public scaffold. Module split is per ADR-0002 (anchorage-internal/adr/0002-public-monorepo-module-split.md); build-discipline tooling inherited per ADR-0001.

**Author:** Valentin Torassa


<!-- New entries go here, newest first. The /ship command and bin/changelog-append.sh insert under this header. -->

---

## Releases

<!--
When cutting a release, rename `[unreleased]` to `[vX.Y.Z] — YYYY-MM-DD`
and start a new empty `[unreleased]` section above it.
-->
