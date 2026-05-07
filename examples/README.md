# examples

Worked examples: end-to-end flows demonstrating how the pieces fit.

> Status: scaffold. See `AGENTS.md` and `SOUL.md` at the repo root for project-wide context.

## issue-reader

Reads a real GitHub issue through the reference runner. Requires a token with `repo` read scope in `GH_TOKEN` or `GITHUB_TOKEN`.

```bash
pnpm install
pnpm -r build
GH_TOKEN=$(gh auth token) node cli/anchorage-runner/dist/index.js \
  run issue-reader < examples/tasks/issue-read.json
```

The example task targets `AnchorageLabs/anchorage#1`. Edit `examples/tasks/issue-read.json` to point at any other public or accessible issue.

## planner

Turns an issue summary into an implementation plan artifact for the next coder agent. Requires Bedrock auth via `AWS_BEARER_TOKEN_BEDROCK` or standard AWS credentials; optionally set `AWS_REGION` and `ANCHORAGE_PLANNER_MODEL` to override the default `us.anthropic.claude-sonnet-4-6` inference profile.

```bash
pnpm install
pnpm -r build
node cli/anchorage-runner/dist/index.js \
  run planner < examples/tasks/plan-create.json
```

The planner also accepts a prior local `issue.summary` artifact through `context.priorArtifacts`.

## coder

Applies an implementation plan by running an external coding CLI in a target workspace. By default it runs `claude -p <prompt>`; override the command with `ANCHORAGE_CODER_COMMAND` and the argument array with `ANCHORAGE_CODER_ARGS_JSON`.

```bash
pnpm install
pnpm -r build
node cli/anchorage-runner/dist/index.js \
  run coder < examples/tasks/code-change.json
```

The example targets the repo root through `input.workspacePath: "../.."` because agents execute from their own package directories.
