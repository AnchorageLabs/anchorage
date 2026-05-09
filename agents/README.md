# agents

Reference agent implementations and the agent contract.

> Status: scaffold. See `AGENTS.md` and `SOUL.md` at the repo root for project-wide context.

Implemented reference agents:

- `issue-reader`: reads a GitHub issue and emits `issue.summary`.
- `planner`: turns `issue.summary` into `implementation.plan` for the coder handoff.
- `coder`: applies `implementation.plan` by calling Bedrock and writing workspace changes.
- `pr-opener`: commits workspace changes, pushes a branch, and opens a GitHub PR.
- `reviewer`: reviews PR diffs for scope, safety, and quality.
- `merge-gate`: checks review/CI state and merges approved PRs.
- `deploy-watch`: records input-driven deployment status as `deployment.record`.
- `smoke-test-runner`: runs input-driven HTTP or shell smoke checks.
