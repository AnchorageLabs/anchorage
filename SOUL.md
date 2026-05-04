# SOUL.md — AnchorageLabs/anchorage

> The north-star file. Locked schema — sections are not optional and not negotiable.
> If a PR contradicts SOUL.md, the PR is wrong (or SOUL.md needs an explicit, dated revision).

**Last updated:** 2026-05-04

---

## Mission

<!--
One sentence. The reason this repo exists. Outcome language, not implementation.
Bad: "implement an event bus." Good: "agents in different orchestrators can coordinate without a shared runtime."
-->

Anyone can build an agent that runs against any Anchorage-compatible orchestrator without locking themselves into a single vendor's runtime — the protocol is the contract; the orchestrator is the variable.

## North-star metric

<!--
ONE measurable thing whose movement tells you whether this repo is succeeding.
Must be observable without subjective judgment. Include current value if known.
Examples: "p95 plan→merge latency for issues labeled `agent-eligible`", "% of issues an agent closes without human edits".
-->

- **Metric:** Number of independently-authored agents (not by AnchorageLabs maintainers) that pass the protocol conformance suite.
- **Current:** 0 (pre-v0)
- **Target (90d):** ≥ 3

## Non-goals

<!--
What this repo will NOT do, even if asked. Bullet form, blunt.
This section protects against scope creep — agents must refuse changes that pull the repo toward these.
-->

- **Not an orchestrator.** This repo defines the protocol agents speak; it does not schedule, route, or execute them.
- **Not a model gateway.** No model selection, prompt caching, or inference routing logic.
- **Not a hosted product.** No SaaS code, no billing, no auth flows for end users.
- **Not a generic IPC framework.** The protocol is shaped for software-automation agents; do not generalize it.

## Out-of-scope

<!--
Adjacent problems that are tempting but belong elsewhere. Cite where they DO live.
-->

- The proprietary orchestrator ("mainframe") — lives in a separate private repo.
- Internal strategy, customer onboarding, billing, telemetry — `anchorage-internal/`.
- Build/release discipline tooling — `anchorage-internal/anchorage-build/`.

## Principles

<!--
The trade-off rules that decide ambiguous calls. 3–7 bullets. Each one a tension, not a slogan.
Example: "Prefer protocol stability over feature velocity — once shipped, breaking changes need an ADR."
-->

- **Protocol stability over feature velocity.** Once a protocol version is published, breaking changes need an ADR and a deprecation window.
- **Reference implementations follow the spec, not the other way around.** If the SDK and the spec disagree, the spec is right and the SDK is the bug.
- **Open-core boundary is sacred.** The orchestrator stays private. The protocol, SDK, runner, and adapters stay public. Code does not migrate across this line without an ADR.
- **Composability over completeness.** A small, well-shaped protocol that adapters can extend beats a sprawling protocol that tries to cover every case.
- **Apache-2.0, no contributor-hostile clauses.** Anyone can fork, embed, and re-license derivatives within Apache-2.0 terms.

---

## Revision policy

Changes to Mission, North-star metric, Non-goals, or Out-of-scope require:
1. An ADR in `anchorage-internal/adr/`
2. Explicit approval from both maintainers (Valentin + Sol)
3. A `CHANGELOG.md` entry citing the ADR

Principles can be revised more freely but each revision still gets a CHANGELOG entry.
