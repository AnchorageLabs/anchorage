# issue-opener

Turns a natural-language instruction into a detailed GitHub issue, then creates it in the repo.

Given an `issue.open` task with `input.instruction` (free-form text) and `input.workspacePath`
(a checked-out copy of the repo), the agent runs a bounded, provider-agnostic ReAct loop over the
configured LLM (`ANCHORAGE_LLM_PROVIDER`): it lists directories, reads files, and greps the code
to ground itself in the real implementation, then drafts a structured issue (problem, context with
concrete file paths, proposed approach, acceptance criteria, out-of-scope) and opens it via the
GitHub API.

## Inputs

- `input.instruction` — what the user wants (a feature, fix, or change).
- `input.workspacePath` — path the agent scans (read-only).
- `task.repository.{owner,name}` — where the issue is created.
- `GH_TOKEN` / `GITHUB_TOKEN` — token with `repo` scope.

## Outputs (artifacts)

- `issue.opened` — `{ issueNumber, issueUrl, title }`, a record of the created issue.
- `issue.summary` — the same shape `issue-reader` emits, so downstream agents (`planner`,
  `issue-triage`) can consume it directly without re-fetching the issue.

## Pipeline modes

- **Create + run**: workflows `instruction-to-code` / `instruction-to-pr` / `instruction-to-merge`
  start with this agent, then continue into plan → code → PR …
- **Create only**: workflow `open-issue` runs just this agent.
- **Existing issue**: the legacy `issue-to-*` workflows (starting with `issue-reader`) are unchanged.

## Exploration bounds

The loop is capped at 12 steps with truncated observations and a path guard that rejects any
read outside `workspacePath` — it executes model-chosen reads against the filesystem, so it stays
read-only and inside the repo.
