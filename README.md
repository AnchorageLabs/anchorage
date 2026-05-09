# anchorage

Open-core protocol, SDK, runner, and reference agents for end-to-end software automation.

> **Status: pre-v0 reference implementation.** The protocol, runner, and reference agents are runnable, but APIs, packages, and layout are not stable. Production users: not yet.

This monorepo holds the public pieces of the AnchorageLabs stack:

| Path | What |
|---|---|
| [`protocol/`](protocol/) | Wire-format spec for the orchestration protocol |
| [`sdk/typescript/`](sdk/typescript/) | TypeScript SDK implementing the protocol |
| [`cli/anchorage-runner/`](cli/anchorage-runner/) | Reference CLI: `anchorage run <agent> < input.json` |
| [`agents/`](agents/) | Reference agent implementations and the agent contract |
| [`adapters/mcp/`](adapters/mcp/) | Model Context Protocol adapter |
| [`adapters/a2a/`](adapters/a2a/) | Agent-to-Agent adapter |
| [`examples/`](examples/) | End-to-end worked examples |

The proprietary orchestrator (the "mainframe") that consumes this protocol lives in a private repo and is not part of this monorepo. The protocol itself, the SDK, and the runner are open source so anyone can build agents that target an Anchorage-compatible orchestrator.

## Current reference surface

- Protocol v0.1 draft in [`protocol/SPEC.md`](protocol/SPEC.md).
- TypeScript validation helpers in [`sdk/typescript/`](sdk/typescript/).
- CLI runner in [`cli/anchorage-runner/`](cli/anchorage-runner/).
- Reference agents in [`agents/`](agents/): issue reading, planning, coding, local tests, PR opening, review, merge preparation, deployment observation, and smoke testing.
- Runnable task envelopes in [`examples/tasks/`](examples/tasks/).

This repo does not sequence workflows, persist durable run state, receive GitHub webhooks, or implement private deployment infrastructure. Those responsibilities belong to an orchestrator that consumes the public protocol.

## License

Apache-2.0. See [`LICENSE`](LICENSE).

## Contributing

The agent-driven contributor docs live in [`AGENTS.md`](AGENTS.md). The repo's north-star is in [`SOUL.md`](SOUL.md). Substantive changes follow the discipline described in `AGENTS.md` §8 — every PR carries a `CHANGELOG.md` entry citing the issue or ADR that motivates it.

## Maintainers

Valentin Torassa, Sol Soletti.
