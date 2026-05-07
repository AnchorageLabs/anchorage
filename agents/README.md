# agents

Reference agent implementations and the agent contract.

> Status: scaffold. See `AGENTS.md` and `SOUL.md` at the repo root for project-wide context.

Implemented reference agents:

- `issue-reader`: reads a GitHub issue and emits `issue.summary`.
- `planner`: turns `issue.summary` into `implementation.plan` for the coder handoff.
- `coder`: applies `implementation.plan` by wrapping an external coding CLI.
