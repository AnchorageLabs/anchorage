# anchorage

Open-core orchestration platform for end-to-end software automation.

> **Status: pre-v0 scaffold.** APIs, packages, and layout are not stable. Expect everything to move. Production users: not yet.

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

## License

Apache-2.0. See [`LICENSE`](LICENSE).

## Contributing

The agent-driven contributor docs live in [`AGENTS.md`](AGENTS.md). The repo's north-star is in [`SOUL.md`](SOUL.md). Substantive changes follow the discipline described in `AGENTS.md` §8 — every PR carries a `CHANGELOG.md` entry citing the issue or ADR that motivates it.

## Maintainers

Valentin Torassa, Sol Soletti.
