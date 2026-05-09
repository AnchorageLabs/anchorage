# examples

Worked examples: end-to-end flows demonstrating how the pieces fit.

> Status: runnable pre-v0 task envelopes for the public reference agents. See `AGENTS.md` and `SOUL.md` at the repo root for project-wide context.

Build once before running examples:

```bash
pnpm install
pnpm -r build
```

## issue-reader

Reads a real GitHub issue through the reference runner. Requires a token with `repo` read scope in `GH_TOKEN` or `GITHUB_TOKEN`.

```bash
GH_TOKEN=$(gh auth token) node cli/anchorage-runner/dist/index.js \
  run issue-reader < examples/tasks/issue-read.json
```

The example task targets `AnchorageLabs/anchorage#1`. Edit `examples/tasks/issue-read.json` to point at any other public or accessible issue.

## planner

Turns an issue summary into an implementation plan artifact for the next coder agent. Requires Bedrock auth via `AWS_BEARER_TOKEN_BEDROCK` or standard AWS credentials; optionally set `AWS_REGION` and `ANCHORAGE_PLANNER_MODEL` to override the default `us.anthropic.claude-sonnet-4-6` inference profile.

```bash
node cli/anchorage-runner/dist/index.js \
  run planner < examples/tasks/plan-create.json
```

The planner also accepts a prior local `issue.summary` artifact through `context.priorArtifacts`.

## coder

Applies an implementation plan by calling Bedrock with Opus 4.7 and writing returned file edits into a target workspace. Requires Bedrock auth via `AWS_BEARER_TOKEN_BEDROCK` or standard AWS credentials; optionally set `AWS_REGION` and `ANCHORAGE_CODER_MODEL` to override the default `us.anthropic.claude-opus-4-7` inference profile.

```bash
node cli/anchorage-runner/dist/index.js \
  run coder < examples/tasks/code-change.json
```

The example targets the repo root through `input.workspacePath: "../.."` because agents execute from their own package directories.

## tester

Runs configured local test commands in a workspace and writes a `test.report` artifact.

```bash
node cli/anchorage-runner/dist/index.js \
  run tester < examples/tasks/test-run.json
```

## pr-opener

Commits changed files from a `code.change.result`, pushes the branch, and opens a GitHub PR. Uses the standard `pull_request.open` task type and requires GitHub write access plus a real git worktree.

```bash
GH_TOKEN=$(gh auth token) node cli/anchorage-runner/dist/index.js \
  run pr-opener < examples/tasks/pr-open.json
```

## reviewer

Reviews a PR diff with Bedrock and posts a GitHub PR comment when granted GitHub write access. Uses the standard `review.run` task type.

```bash
GH_TOKEN=$(gh auth token) node cli/anchorage-runner/dist/index.js \
  run reviewer < examples/tasks/pr-review.json
```

## merge-gate

Checks PR state and merges when configured gates pass. Uses the standard `merge.prepare` task type.

```bash
GH_TOKEN=$(gh auth token) node cli/anchorage-runner/dist/index.js \
  run merge-gate < examples/tasks/merge-prepare.json
```

## ci-watcher

Watches GitHub checks/statuses for a PR and writes a `ci.report` artifact. The agent reports `passed`, `failed`, or `timed_out`; routing a failed result back to `code.change` is an orchestrator responsibility.

```bash
GH_TOKEN=$(gh auth token) node cli/anchorage-runner/dist/index.js \
  run ci-watcher < examples/tasks/ci-watch.json
```

## deploy-watch

Records an input-driven deployment status without referencing private deployment infrastructure.

```bash
node cli/anchorage-runner/dist/index.js \
  run deploy-watch < examples/tasks/deploy-watch.json
```

## smoke-test-runner

Runs configured HTTP or shell smoke checks and writes a `smoke_test.report` artifact.

```bash
node cli/anchorage-runner/dist/index.js \
  run smoke-test-runner < examples/tasks/smoke-test-run.json
```

## Out of scope for examples

The examples invoke one agent at a time. Durable workflow sequencing, retry policy, CI-failure routing, webhook handling, and run ledger persistence are orchestrator responsibilities and are not implemented in this public repo.
