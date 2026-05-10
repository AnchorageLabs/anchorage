# issue-triage

Reference agent for the `issue.triage` task type.

Consumes a prior `issue.summary` artifact (or direct `input.issue` fields) and calls Bedrock to produce a structured triage decision: scope, type, priority, readiness, agent-eligibility, and suggested GitHub labels. Optionally applies labels when granted `github.write`.

## Task type

`issue.triage`

## Required capability

`llm.plan`

## Optional capability

`github.write` — enables label application on the source issue.

## Inputs

Reads the issue from `context.priorArtifacts` (`artifactType: "issue.summary"`) or from `input.issue` directly.

## Outputs

Emits an `issue.triage.result` artifact (`triage-result.json`) with:

| Field | Type | Description |
|---|---|---|
| `scope` | string | `bug` \| `feature` \| `refactor` \| `docs` \| `chore` \| `unclear` |
| `type` | string | `backend` \| `frontend` \| `cli` \| `infra` \| `protocol` \| `test` \| `mixed` \| `unknown` |
| `priority` | string | `critical` \| `high` \| `medium` \| `low` |
| `readiness` | string | `ready` \| `needs-detail` \| `blocked` \| `out-of-scope` |
| `agentEligible` | boolean | `true` when readiness is `ready` and the issue is specific enough for autonomous coding |
| `suggestedLabels` | string[] | Short GitHub label names |
| `reasoning` | string | One-paragraph explanation of the triage decision |

## Usage

```bash
GH_TOKEN=$(gh auth token) node cli/anchorage-runner/dist/index.js \
  run issue-triage < examples/tasks/issue-triage.json
```

The example reads a prior `issue.summary` artifact. Run `issue-reader` first to produce one, or pass `input.issue` directly in the task envelope.

Add `github.write` to `capabilities` and set `GH_TOKEN`/`GITHUB_TOKEN` to have the agent apply the suggested labels to the GitHub issue.

## Constraints

- Does not embed private prioritization policy or orchestrator routing logic.
- Label writes are capability-gated and non-fatal if they fail.
- Read-only mode (no `github.write`) still emits a full triage decision.
