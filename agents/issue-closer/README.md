# issue-closer

Reference agent for the `issue.close` task type.

Closes a GitHub issue after a workflow completes and posts a concise summary comment with links to the PR, commit, test report, CI report, deployment, smoke test, and other artifacts when provided.

## Task type

`issue.close`

## Required capability

`github.write`

## Inputs

| Field | Type | Required | Description |
|---|---|---|---|
| `input.issue.issueNumber` | number | yes | GitHub issue number to close. |
| `input.summary.text` | string | no | Short summary text posted as comment header. |
| `input.summary.prUrl` | string | no | URL of the merged PR. |
| `input.summary.commitSha` | string | no | Merge commit SHA. |
| `input.summary.testReportUri` | string | no | URI of the `test.report` artifact. |
| `input.summary.ciReportUri` | string | no | URI of the `ci.report` artifact. |
| `input.summary.deploymentUri` | string | no | URI of the deployment record. |
| `input.summary.smokeTestUri` | string | no | URI of the smoke test report. |
| `input.summary.artifacts` | string[] | no | Additional artifact URIs to list in the comment. |

`repository.owner` and `repository.name` must be set in the task envelope.

## Outputs

Emits an `issue.closed` artifact and writes `issue-closed.json` to `ANCHORAGE_ARTIFACT_DIR` (or a run-scoped temp directory).

## Usage

```bash
GH_TOKEN=$(gh auth token) node cli/anchorage-runner/dist/index.js \
  run issue-closer < examples/tasks/issue-close.json
```

Set `GITHUB_TOKEN` or `GH_TOKEN` with a token that has issue write access on the target repository.

## Constraints

- Does not encode workflow routing or retry logic.
- Summary comment omits secrets, raw transcripts, and internal infrastructure references.
- Issue number must be a positive integer; PR numbers are rejected.
