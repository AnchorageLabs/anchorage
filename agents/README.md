# agents

Reference agent implementations and the agent contract.

> Status: runnable pre-v0 reference agents. See `AGENTS.md` and `SOUL.md` at the repo root for project-wide context and public/private boundary rules.

Implemented reference agents:

- `issue-reader`: reads a GitHub issue and emits `issue.summary`.
- `planner`: turns `issue.summary` into `implementation.plan` for the coder handoff.
- `coder`: applies `implementation.plan` by calling Bedrock and writing workspace changes.
- `tester`: runs configured local test commands and emits `test.report`.
- `pr-opener`: commits workspace changes, pushes a branch, and opens a GitHub PR.
- `ci-watcher`: watches GitHub PR checks/statuses and emits `ci.report`.
- `reviewer`: reviews PR diffs for scope, safety, and quality.
- `merge-gate`: checks review/CI state and merges approved PRs.
- `deploy-watch`: records input-driven deployment status as `deployment.record`.
- `smoke-test-runner`: runs input-driven HTTP or shell smoke checks.
- `issue-closer`: closes the originating GitHub issue and posts a concise workflow summary comment.
- `issue-triage`: classifies scope, type, priority, readiness, and agent-eligibility of an issue. Optionally applies GitHub labels.

## Current gaps

None — all standard v0.1 lifecycle task types are implemented.

Agents observe or act on one task and emit protocol events. Workflow routing, retries, loop limits, durable state, and webhook handling are orchestrator responsibilities and are intentionally outside this public repo.

## Task type names

- PR opening uses `pull_request.open`.
- Automated PR review uses `review.run`.
- Merge preparation uses `merge.prepare`.
