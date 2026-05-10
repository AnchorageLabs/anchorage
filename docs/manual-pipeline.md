# Manual v0 pipeline recipe

This document shows how to run the full public reference agent chain against a sandbox GitHub issue without the private orchestrator. Every step is a local CLI invocation; durable sequencing, retry routing, and state persistence are orchestrator responsibilities and are not replicated here.

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js ≥ 20 | Node 22 recommended; 20 works with a deprecation warning |
| `pnpm` via corepack | `corepack enable` then `corepack pnpm --version` |
| AWS credentials | For Bedrock (planner, coder, reviewer). `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` or `AWS_PROFILE` or `AWS_BEARER_TOKEN_BEDROCK` |
| `gh` CLI authenticated | `gh auth login` — needs `repo` scope on the sandbox repo |
| A sandbox GitHub repo | The recipe uses `AnchorageLabs/envy`. Substitute any accessible repo. |

## Environment variables

```bash
# Required
export ISSUE=<issue-number>           # GitHub issue number to resolve
export WORKSPACE=<path-to-worktree>   # Local clone of the target repo
export GH_TOKEN=$(gh auth token)
export GITHUB_TOKEN="$GH_TOKEN"

# Set automatically by the recipe
export RUN_ID="run_envy_${ISSUE}_$(date +%Y%m%d%H%M%S)"
export ARTIFACT_DIR="/tmp/anchorage-agent-artifacts/${RUN_ID}"
export ANCHORAGE_ARTIFACT_DIR="$ARTIFACT_DIR"
```

Optional overrides:

```bash
export ANCHORAGE_PLANNER_MODEL="us.anthropic.claude-sonnet-4-6"   # default
export ANCHORAGE_CODER_MODEL="us.anthropic.claude-opus-4-7"       # default
export ANCHORAGE_CODER_MAX_TOKENS=120000                          # default
```

## Step 0 — Build

```bash
cd /path/to/anchorage
git switch main
git pull --ff-only origin main
corepack pnpm install
corepack pnpm -r build
```

## Step 1 — Set variables and reset workspace

```bash
export ISSUE=<issue-number>
export WORKSPACE=<path-to-target-repo>
export RUN_ID="run_envy_${ISSUE}_$(date +%Y%m%d%H%M%S)"
export ARTIFACT_DIR="/tmp/anchorage-agent-artifacts/${RUN_ID}"
export ANCHORAGE_ARTIFACT_DIR="$ARTIFACT_DIR"
export GH_TOKEN=$(gh auth token)
export GITHUB_TOKEN="$GH_TOKEN"

mkdir -p "$ARTIFACT_DIR"
git -C "$WORKSPACE" switch main
git -C "$WORKSPACE" pull --ff-only origin main
test -z "$(git -C "$WORKSPACE" status --porcelain)"
echo "RUN_ID: $RUN_ID"
```

## Step 2 — Generate Phase 1 task files

```bash
node - <<'NODE'
const fs = require("fs");
const issue = Number(process.env.ISSUE);
const runId = process.env.RUN_ID;
const workspace = process.env.WORKSPACE;
const artifactDir = process.env.ARTIFACT_DIR;
const repo = { provider: "github", owner: "AnchorageLabs", name: "envy", defaultBranch: "main" };
const base = (id, type, agent, input, capabilities, priorArtifacts = []) => ({
  protocolVersion: "0.1",
  task: { id, type, createdAt: new Date().toISOString(), deadlineAt: null },
  run: { id: runId, attempt: 1, correlationId: `corr_envy_${issue}` },
  actor: { requestedBy: "developer", agent },
  repository: repo,
  input,
  capabilities,
  policy: { maxDurationSeconds: 900 },
  context: { parentTaskId: null, priorArtifacts }
});
const write = (name, value) =>
  fs.writeFileSync(`${artifactDir}/${name}`, JSON.stringify(value, null, 2) + "\n");

write("task-issue-read.json", base(
  `task_envy_${issue}_issue_read`, "issue.read", "issue-reader",
  { issueNumber: issue }, ["github.read"]
));
write("task-plan-create.json", base(
  `task_envy_${issue}_plan_create`, "plan.create", "planner",
  {}, ["llm.plan", "github.write"],
  [{ artifactType: "issue.summary", uri: `file://${artifactDir}/issue-summary.json`, mediaType: "application/json" }]
));
write("task-code-change.json", base(
  `task_envy_${issue}_code_change`, "code.change", "coder",
  { workspacePath: workspace },
  ["workspace.read", "workspace.write", "llm.code", "shell.exec"],
  [{ artifactType: "implementation.plan", uri: `file://${artifactDir}/implementation-plan.json`, mediaType: "application/json" }]
));
write("task-test-run.json", base(
  `task_envy_${issue}_test_run`, "test.run", "tester",
  {
    workspacePath: workspace,
    commands: [
      { name: "create test venv",  command: `python3 -m venv /tmp/envy-anchorage-test-${issue}` },
      { name: "install package",   command: `/tmp/envy-anchorage-test-${issue}/bin/python -m pip install -e .` },
      { name: "compile check",     command: `/tmp/envy-anchorage-test-${issue}/bin/python -m compileall src` },
      { name: "unit tests",        command: `PYTHONPATH=src /tmp/envy-anchorage-test-${issue}/bin/python -m unittest discover -s tests` },
      { name: "cli smoke",         command: `/tmp/envy-anchorage-test-${issue}/bin/envy --help` }
    ]
  },
  ["workspace.read", "shell.exec", "github.write"],
  [{ artifactType: "code.change.result", uri: `file://${artifactDir}/code-change-result.json`, mediaType: "application/json" }]
));
write("task-pr-open.json", base(
  `task_envy_${issue}_pr_open`, "pull_request.open", "pr-opener",
  { workspacePath: workspace },
  ["github.write", "workspace.write", "shell.exec"],
  [
    { artifactType: "code.change.result",  uri: `file://${artifactDir}/code-change-result.json`,  mediaType: "application/json" },
    { artifactType: "implementation.plan", uri: `file://${artifactDir}/implementation-plan.json`, mediaType: "application/json" }
  ]
));
console.log("Phase 1 tasks written to", artifactDir);
NODE
```

## Step 3 — Run Phase 1 agents

```bash
ANCHORAGE_ARTIFACT_DIR="$ARTIFACT_DIR" node cli/anchorage-runner/dist/index.js run issue-reader  < "$ARTIFACT_DIR/task-issue-read.json"
ANCHORAGE_ARTIFACT_DIR="$ARTIFACT_DIR" node cli/anchorage-runner/dist/index.js run planner       < "$ARTIFACT_DIR/task-plan-create.json"
ANCHORAGE_ARTIFACT_DIR="$ARTIFACT_DIR" node cli/anchorage-runner/dist/index.js run coder         < "$ARTIFACT_DIR/task-code-change.json"
ANCHORAGE_ARTIFACT_DIR="$ARTIFACT_DIR" node cli/anchorage-runner/dist/index.js run tester        < "$ARTIFACT_DIR/task-test-run.json"
ANCHORAGE_ARTIFACT_DIR="$ARTIFACT_DIR" node cli/anchorage-runner/dist/index.js run pr-opener     < "$ARTIFACT_DIR/task-pr-open.json"
```

After `pr-opener` completes, the PR number and URL are in `$ARTIFACT_DIR/pr-opened.json`.

## Step 4 — Generate Phase 2 task files

```bash
node - <<'NODE'
const fs = require("fs");
const issue = Number(process.env.ISSUE);
const runId = process.env.RUN_ID;
const artifactDir = process.env.ARTIFACT_DIR;
const pr = JSON.parse(fs.readFileSync(`${artifactDir}/pr-opened.json`, "utf8"));
const repo = { provider: "github", owner: "AnchorageLabs", name: "envy", defaultBranch: "main" };
const base = (id, type, agent, input, capabilities, priorArtifacts = []) => ({
  protocolVersion: "0.1",
  task: { id, type, createdAt: new Date().toISOString(), deadlineAt: null },
  run: { id: runId, attempt: 1, correlationId: `corr_envy_${issue}` },
  actor: { requestedBy: "developer", agent },
  repository: repo,
  input,
  capabilities,
  policy: { maxDurationSeconds: 900 },
  context: { parentTaskId: null, priorArtifacts }
});
const write = (name, value) =>
  fs.writeFileSync(`${artifactDir}/${name}`, JSON.stringify(value, null, 2) + "\n");

write("task-ci-watch.json", base(
  `task_envy_${issue}_ci_watch`, "ci.watch", "ci-watcher",
  { pr: { prNumber: pr.prNumber }, pollIntervalMs: 10000, maxPolls: 30 },
  ["github.read"]
));
write("task-pr-review.json", base(
  `task_envy_${issue}_pr_review`, "review.run", "reviewer",
  {}, ["github.read", "github.write", "llm.review"],
  [{ artifactType: "pr.opened", uri: `file://${artifactDir}/pr-opened.json`, mediaType: "application/json" }]
));
write("task-merge-prepare.json", base(
  `task_envy_${issue}_merge_prepare`, "merge.prepare", "merge-gate",
  {}, ["github.read", "github.write"],
  [
    { artifactType: "pr.review.result", uri: `file://${artifactDir}/pr-review-result.json`, mediaType: "application/json" },
    { artifactType: "ci.report",        uri: `file://${artifactDir}/ci-report.json`,         mediaType: "application/json" }
  ]
));
write("task-issue-close.json", base(
  `task_envy_${issue}_issue_close`, "issue.close", "issue-closer",
  {
    issue: { issueNumber: issue },
    summary: {
      text: "Workflow completed successfully.",
      prUrl: pr.prUrl,
      testReportUri: `file://${artifactDir}/test-report.json`,
      ciReportUri:   `file://${artifactDir}/ci-report.json`,
      artifacts: [
        `file://${artifactDir}/code-change-result.json`,
        `file://${artifactDir}/merge-completed.json`
      ]
    }
  },
  ["github.write"]
));
console.log(`Phase 2 tasks written — PR #${pr.prNumber}`);
NODE
```

## Step 5 — Run Phase 2 agents

```bash
ANCHORAGE_ARTIFACT_DIR="$ARTIFACT_DIR" node cli/anchorage-runner/dist/index.js run ci-watcher   < "$ARTIFACT_DIR/task-ci-watch.json"
ANCHORAGE_ARTIFACT_DIR="$ARTIFACT_DIR" node cli/anchorage-runner/dist/index.js run reviewer     < "$ARTIFACT_DIR/task-pr-review.json"
ANCHORAGE_ARTIFACT_DIR="$ARTIFACT_DIR" node cli/anchorage-runner/dist/index.js run merge-gate   < "$ARTIFACT_DIR/task-merge-prepare.json"
ANCHORAGE_ARTIFACT_DIR="$ARTIFACT_DIR" node cli/anchorage-runner/dist/index.js run issue-closer < "$ARTIFACT_DIR/task-issue-close.json"
```

## Artifacts

All artifacts land in `$ARTIFACT_DIR`:

| File | Produced by | Consumed by |
|---|---|---|
| `issue-summary.json` | `issue-reader` | `planner` |
| `implementation-plan.json` | `planner` | `coder`, `pr-opener` |
| `code-change-result.json` | `coder` | `tester`, `pr-opener` |
| `test-report.json` | `tester` | `issue-closer` |
| `pr-opened.json` | `pr-opener` | `ci-watcher`, `reviewer`, `merge-gate` |
| `ci-report.json` | `ci-watcher` | `merge-gate`, `issue-closer` |
| `pr-review-result.json` | `reviewer` | `merge-gate` |
| `merge-completed.json` | `merge-gate` | `issue-closer` |
| `issue-closed.json` | `issue-closer` | — |

Task files (`task-*.json`) are also written to `$ARTIFACT_DIR` for debugging and re-runs.

## Retrying a failed step

Each agent reads its inputs from prior artifacts. If a step fails, fix the underlying issue and re-run that step and all subsequent steps with the same `$ARTIFACT_DIR`. The earlier artifacts remain valid.

```bash
# Example: re-run from coder onwards
ANCHORAGE_ARTIFACT_DIR="$ARTIFACT_DIR" node cli/anchorage-runner/dist/index.js run coder < "$ARTIFACT_DIR/task-code-change.json"
# then tester, pr-opener, …
```

## GitHub comments

Add `github.write` to the planner and tester capabilities (already included in the task files above) to have those agents post plan and test summaries as GitHub issue comments. `GITHUB_TOKEN` or `GH_TOKEN` must be set.

## Scope

This recipe runs one agent at a time. **Durable workflow sequencing, retry routing on CI failure, loop limits, run ledger persistence, and webhook handling are private orchestrator responsibilities and are not implemented here.**
