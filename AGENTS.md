# AGENTS.md — AnchorageLabs/anchorage

**Last updated:** 2026-05-09
**Visibility:** public
**Maintainers:** Valentin Torassa, Sol Soletti

> Read this first before making changes. This file is the contract between human and agent for *this* repo. The org-level contract lives in `anchorage-internal/AGENTS.md` and is the canonical authority for AnchorageLabs as a whole.

---

## §1. What this repo is

<!--
One paragraph. What problem does this repo solve, and for whom?
Avoid implementation details — those go in §3. This section should still be true after a year.
-->

The open-core surface of the AnchorageLabs orchestration platform. It contains the wire-format protocol, a TypeScript SDK, a reference CLI, reference agents, and the MCP / A2A adapters — everything an outside contributor needs to build agents that target an Anchorage-compatible orchestrator. The proprietary orchestrator itself (the "mainframe") lives in a separate private repo and is not part of this monorepo.

## §2. North star

<!--
One sentence — pulled from SOUL.md. The single outcome this repo's existence is meant to produce.
If you cannot answer "did this PR move us toward the north star?", the PR is probably out of scope.
-->

See `SOUL.md` for the locked north-star schema (mission, metric, non-goals, principles).

## §3. Architecture overview

<!--
The shape of the code. Module boundaries, key abstractions, why those boundaries exist.
Cite file paths. Not a tour — a map.
-->

Monorepo, eight top-level modules. The split exists so the protocol spec can move at a different cadence than implementations, and so adapters live next to (not inside) the SDK.

- `protocol/` — wire-format spec (the contract; changes here are ADR-gated).
- `sdk/typescript/` — TypeScript implementation of the protocol.
- `cli/anchorage-runner/` — reference runner: `anchorage run <agent> < input.json`.
- `agents/` — reference agent implementations and the agent contract.
- `adapters/mcp/` — Model Context Protocol adapter.
- `adapters/a2a/` — Agent-to-Agent adapter.
- `examples/` — end-to-end worked examples.
- `docs/` — user-facing documentation (manual pipeline recipe, how-tos).

**Implemented reference agents (all v0.1 task types covered):**

| Agent | Task type | Notes |
|---|---|---|
| `issue-triage` | `issue.triage` | LLM classification; optional GitHub label writes |
| `issue-reader` | `issue.read` | GitHub API; rejects PRs and warns on closed issues |
| `planner` | `plan.create` | Bedrock Sonnet; posts plan comment when `github.write` granted |
| `coder` | `code.change` | Bedrock Opus; resets workspace on failure |
| `tester` | `test.run` | Shell commands; posts test summary when `github.write` granted |
| `pr-opener` | `pull_request.open` | Bedrock-generated title+body; verifies clean branch |
| `ci-watcher` | `ci.watch` | GitHub checks/statuses polling |
| `reviewer` | `review.run` | Bedrock Sonnet; posts PR review comment |
| `merge-gate` | `merge.prepare` | Consumes `ci.report`; surfaces review context on block |
| `deploy-watch` | `deploy.watch` | Input-driven status record |
| `smoke-test-runner` | `smoke_test.run` | HTTP/shell smoke checks |
| `issue-closer` | `issue.close` | GitHub API; posts workflow summary comment |

## §4. How to run / develop

<!--
Concrete commands. Install, build, test, lint, run locally, deploy if applicable.
Should be copy-pasteable. If a command requires setup (env vars, accounts), say so.
-->

```bash
# install
corepack pnpm install

# build
corepack pnpm -r build

# test
corepack pnpm -r test

# run a single agent
GH_TOKEN=$(gh auth token) node cli/anchorage-runner/dist/index.js run issue-reader < examples/tasks/issue-read.json
```

Full pipeline recipe: `docs/manual-pipeline.md`.

## §5. Public/private repo boundary

<!--
What MUST NOT cross from this repo into the public `anchorage` repo (or vice versa).
Common: secrets, customer data, internal strategy, proprietary orchestrator logic.
Per `anchorage-internal/AGENTS.md` §5 — agents must not move code across this boundary without explicit approval.
-->

This repo is **public**. Nothing private must land here. Specifically:

- No proprietary orchestrator logic (planner internals, mainframe scheduling, billing).
- No customer data, telemetry exports, or internal incident references.
- No internal strategy docs, roadmaps, or competitive analysis.
- No paths to private infrastructure (AWS account IDs in code, internal endpoints).

If a change here references something in `anchorage-internal/`, the reference is fine — but the substance must not leak into commit messages, code comments, or doc bodies.

## §6. Agent operating notes

<!--
Repo-specific guidance for coding agents. What patterns to reuse, what to avoid, what tests are non-negotiable.
General agent policy lives in `anchorage-internal/coding-agent-operating-policy.md` — do not duplicate it here.
-->

- Pre-v0: APIs, packages, and layout WILL move. Don't preserve interfaces across changes unless an ADR locks them.
- Public-repo discipline: assume external eyes. No internal jargon in PR descriptions, no references to private repos in user-facing docs (READMEs, error messages, generated output).
- Apache-2.0 only. License headers are not required on every file but new dependencies must be Apache-2.0-compatible.
- Substantive changes to anything under `protocol/` are arch-sensitive and require an ADR per the ship-ritual Phase 3 (see §8).
- Reference agents should use the standard v0.1 task types in `protocol/SPEC.md` and include runnable example envelopes under `examples/tasks/`.

## §7. Issue & branch conventions

- Branches follow `issue-N-<short-slug>` so that the `anchorage-build` plugin can auto-fetch issue context. Looser shapes such as bare-number-prefix slugs (e.g. `42-rename-foo`) and feat-prefixed variants are also recognized by the hook.
- If a branch has no issue number, the agent will ask the user whether the work belongs to an issue — answer explicitly. Spikes and exploration are valid answers; silence is not.
- Issues use the template in `anchorage-internal/agent-issue-template.md`.
- Every substantive PR ships with a `CHANGELOG.md` entry and (if it touches docs) an `AGENTS.md` update.

## §8. Shipping discipline (inherited by all agents)

> Both Claude and Codex MUST follow this ritual before considering any substantive change "done." The agent invokes it on its own — the user does not have to ask.

Before committing a substantive change:

1. **Run the ritual.** Invoke the canonical engine at `anchorage-internal/anchorage-build/bin/ship.sh`. Claude can also auto-trigger via the `ship` skill or the slash command of the same name. Codex invokes the script directly.
2. **Phase 1 — Pre-flight.** The companion script `anchorage-internal/anchorage-build/bin/sync-agents-md.sh` reports `AGENTS.md` / `SOUL.md` / `CHANGELOG.md` health. Resolve any issues before continuing.
3. **Phase 2 — CHANGELOG entry.** If `[unreleased]` has no entry covering this change, append one with `anchorage-internal/anchorage-build/bin/changelog-append.sh`. Intent in outcome language; reason cites issue / ADR / runbook / incident; no AI co-authors.
4. **Phase 3 — Architecture sensitivity.** If the ritual flags arch-sensitive paths (public API, build config, CI, new top-level modules, internals architecture/protocol), **draft a Proposed ADR** under `anchorage-internal/adr/` (sequentially-numbered filename) *before* the change lands. Default toward writing one — the user's role is to approve/edit/reject, not to decide whether one is needed.
5. **Phase 4 — Post-flight.** Walk the checklist printed by the ritual: internals coherence, ADR/runbook drafts approved, CHANGELOG cites the right ID, commit message is human-authored.

**Hard rules during shipping:**

- Commit messages are human-authored. No AI-assistant `Co-Authored-By` trailers — the prepare-commit-msg hook strips them and the commit-msg hook rejects survivors. Don't write them in the first place.
- CHANGELOG entry is committed in the same commit as the change.
- Internals updates are committed with the code that requires them, not in a follow-up.

## §9. Related docs

- Org-level: `anchorage-internal/AGENTS.md`
- Architecture: `anchorage-internal/architecturev0.1.md`
- Protocol: `anchorage-internal/protocol-specv0.1.md`
- Manual pipeline recipe: `docs/manual-pipeline.md`
- Coding policy: `anchorage-internal/coding-agent-operating-policy.md`
- This repo's north star: `SOUL.md`
- This repo's history: `CHANGELOG.md`
