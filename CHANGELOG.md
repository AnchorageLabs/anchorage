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
