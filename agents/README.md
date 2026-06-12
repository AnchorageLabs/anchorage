# agents

Reference agent implementations and the agent contract.

> Status: runnable pre-v0 reference agents. See `AGENTS.md` and `SOUL.md` at the repo root for project-wide context and public/private boundary rules.

Implemented reference agents:

- `issue-opener`: turns a natural-language instruction into a detailed GitHub issue by exploring the repository, creates it, and emits `issue.opened` + `issue.summary`.
- `issue-reader`: reads a GitHub issue and emits `issue.summary`.
- `planner`: turns `issue.summary` into `implementation.plan` for the coder handoff.
- `coder`: applies `implementation.plan` by calling a configured LLM provider and writing workspace changes.
- `tester`: runs configured local test commands and emits `test.report`.
- `pr-opener`: commits workspace changes, pushes a branch, and opens a GitHub PR.
- `ci-watcher`: watches GitHub PR checks/statuses and emits `ci.report`.
- `reviewer`: reviews PR diffs for scope, safety, and quality.
- `merge-gate`: checks review/CI state and merges approved PRs.
- `deploy-watch`: records input-driven deployment status as `deployment.record`.
- `smoke-test-runner`: runs input-driven HTTP or shell smoke checks.
- `issue-closer`: closes the originating GitHub issue and posts a concise workflow summary comment.
- `issue-triage`: classifies scope, type, priority, readiness, and agent-eligibility of an issue. Optionally applies GitHub labels.
- `notion-reader`: reads a Notion page work item and emits an `issue.summary` artifact, so a Notion task can drive the same planner → coder → PR pipeline as a GitHub issue.
- `notion-writer`: posts the workflow summary back to the originating Notion page as a comment and optionally sets its Status property.

## Current gaps

None — all standard v0.1 lifecycle task types are implemented.

Agents observe or act on one task and emit protocol events. Workflow routing, retries, loop limits, durable state, and webhook handling are orchestrator responsibilities and are intentionally outside this public repo.

## Task type names

- PR opening uses `pull_request.open`.
- Automated PR review uses `review.run`.
- Merge preparation uses `merge.prepare`.
- The Notion connector uses the namespaced custom types `notion.task.read` and `notion.task.update` (per `protocol/SPEC.md` §9, custom task types carry a namespace prefix; no protocol change required).

## Notion connector

`notion-reader` and `notion-writer` let a Notion database act as the work-item source for the pipeline:

1. `notion-reader` (`notion.task.read`, requires `notion.read`) fetches a page by `input.pageId` (raw id, dashed UUID, or page URL) and emits an `issue.summary` artifact in the same shape `issue-reader` produces, so the planner consumes it unchanged. The `issueNumber` comes from the database's `unique_id` property ("Task ID" column) when present, otherwise a stable hash of the page id. A `Repository`/`Repo` page property (`owner/name` text or a GitHub URL) supplies the repository when the envelope omits it. Multi-select properties become labels; a `status`-type property (or select named `Status`) maps Done/Complete/Completed/Closed/Shipped and archived pages to state `closed`.
2. `notion-writer` (`notion.task.update`, requires `notion.write`) posts the workflow summary (PR URL, commit, report URIs) as a comment on the page and, when `input.status` is given, sets the page's status property (`input.statusProperty` overrides auto-detection).

Both authenticate with `NOTION_TOKEN` (or `NOTION_API_KEY`) — an internal integration token whose integration has been granted access to the relevant pages. `NOTION_VERSION` overrides the default `2022-06-28` API version. Example envelopes: `examples/tasks/notion-task-read.json`, `examples/tasks/notion-task-update.json`.

## LLM provider configuration

`issue-opener`, `planner`, `coder`, and `reviewer` use the shared `@anchorage/agent-llm` adapter. Set `ANCHORAGE_LLM_PROVIDER` to choose a provider explicitly:

- `anthropic`: uses `ANTHROPIC_API_KEY`.
- `openai`: uses `OPENAI_API_KEY`.
- `openai-compatible`: uses `ANCHORAGE_LLM_API_KEY` and `ANCHORAGE_LLM_BASE_URL`.
- `moonshot` or `kimi`: uses `MOONSHOT_API_KEY` or `KIMI_API_KEY`; set `ANCHORAGE_LLM_MODEL` or the role-specific model env var.
- `bedrock` or `aws-bedrock`: uses `AWS_BEARER_TOKEN_BEDROCK` or standard AWS credentials.

Model selection is role-specific first, then generic: `ANCHORAGE_PLANNER_MODEL`, `ANCHORAGE_CODER_MODEL`, or `ANCHORAGE_REVIEWER_MODEL` override `ANCHORAGE_LLM_MODEL`. If no provider is set, agents infer one from available credentials in this order: Anthropic, OpenAI, Moonshot/Kimi, OpenAI-compatible with `ANCHORAGE_LLM_BASE_URL`, then Bedrock.
