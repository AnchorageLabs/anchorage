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
