# Anchorage Protocol Specification v0.1

> **Status:** Implemented — all v0.1 task types have public reference agents in `agents/`.
> **Version:** 0.1
> **Last updated:** 2026-05-09
> **Last reviewed:** 2026-05-09 by Valen + Sol
> **License:** Apache-2.0
> **Scope:** CLI ABI, task envelope, NDJSON event schema, exit codes, adapter mapping
> **Non-goals:** orchestrator internals, billing, UI, model gateway, sandbox implementation

---

## 1. Purpose

The Anchorage Protocol is the **open contract** between agents, tools, adapters, and any orchestrator that wants to drive end-to-end software automation workflows.

AnchorageLabs is **not** another coding agent. It is the **substrate other agents plug into** — the stable layer that allows heterogeneous agents, first-party and third-party, to cooperate without hard-coupling to one another. The protocol defines how work enters an agent, how the agent reports progress, and how results flow back, regardless of transport (CLI, MCP, A2A).

Any compliant agent MUST be invocable as a CLI binary. Any compliant orchestrator MUST consume the event stream defined here. Any compliant adapter (MCP, A2A, or future) MUST map losslessly to and from this protocol.

---

## 2. Design Principles

| # | Principle | Implication |
|---|---|---|
| 1 | **CLI-first** | Every capability starts as `stdin JSON → stdout NDJSON → exit code`. No exceptions. |
| 2 | **Protocol-driven** | The contract is the product. Agents and orchestrators evolve independently as long as they honour the spec. |
| 3 | **Durable by default** | Workflows span hours or days. IDs, attempts, and idempotency are built into the envelope, not bolted on. |
| 4 | **Adapters over forks** | MCP and A2A are thin mapping layers over this spec. They MUST NOT introduce behaviour that the CLI path cannot express. |
| 5 | **Stable core, extensible edges** | Core envelope fields and event types are versioned and stable. Agents MAY add custom fields in `data` and `context` without breaking consumers. |
| 6 | **Structured events** | Every action emits machine-readable NDJSON. Human-readable logs go to stderr. |
| 7 | **Public/private boundary** | This protocol is public. It MUST NOT reference, import, or depend on any private orchestrator implementation. |
| 8 | **Framework neutrality** | The protocol MUST NOT depend on LangGraph, CrewAI, or any agent framework. Agents MAY use frameworks internally. |

---

## 3. Core Concepts

| Term | Definition |
|---|---|
| **Task** | A discrete unit of work described by a task envelope. One task = one agent invocation. |
| **Agent** | A CLI binary (or container) that accepts a task envelope on stdin and emits an NDJSON event stream on stdout. |
| **Tool** | A capability an agent invokes during execution (e.g., read a file, run tests, query a DB). Tools are consumed via MCP or direct calls — they are not agents. |
| **Adapter** | A translation layer that maps an external protocol (MCP, A2A) to and from the Anchorage Protocol. |
| **Orchestrator** | Any system that sequences tasks, enforces policy, and persists the event ledger. This spec does not define orchestrator internals. |
| **Event** | A single NDJSON line emitted by an agent on stdout. Events form the audit trail and progress stream. |
| **Artifact** | A durable output of a task: a plan, patch, commit SHA, PR URL, test report, or LLM transcript. Referenced by URI, not embedded. |
| **Run** | A top-level workflow instance (e.g., "process issue #42"). A run contains one or more tasks. |
| **Attempt** | A numbered execution of a specific task within a run. First attempt = 1. Retries increment the attempt. |
| **Correlation ID** | An opaque string that links all tasks, events, and artifacts belonging to the same run. Propagated through delegations. |
| **Capability** | A declared permission or resource an agent requires (e.g., `github.read`, `github.write`, `llm.invoke`). |
| **Policy Gate** | A point in the workflow where policy determines whether to proceed, request human approval, or deny. Represented as events, not agent logic. |

---

## 4. CLI ABI

### 4.1 Invocation

An agent MUST be invocable as:

```bash
anchorage run <agent-name> < task.json
```

Or directly:

```bash
code-writer < task.json
```

### 4.2 Contract

| Channel | Format | Purpose |
|---|---|---|
| **stdin** | Exactly one JSON document (the task envelope) | Agent input |
| **stdout** | NDJSON (one JSON object per line) | Protocol event stream |
| **stderr** | Free-form text | Human/debug diagnostics only. MUST NOT contain structured protocol data. |
| **exit code** | Integer 0–9 | Terminal status (see &sect;7) |

### 4.3 Rules

- Agents MUST NOT require interactive input (no TTY prompts).
- Agents MUST emit at least one `agent.started` event and exactly one terminal event (`agent.completed` or `agent.failed`) before exiting.
- Long-running agents (>30 s expected) MUST emit `agent.heartbeat` events at least every 60 seconds.
- Agents SHOULD be deterministic where possible. Non-deterministic behaviour (e.g., LLM calls) MUST be recorded in events.
- Agents MUST NOT write protocol-relevant data to files, environment variables, or side channels. The event stream is the sole output contract.

---

## 5. Task Envelope

The task envelope is the JSON document delivered on stdin. All fields at the top level are defined by this spec. Agents MUST ignore unknown top-level fields.

### 5.1 Schema

```json
{
  "protocolVersion": "0.1",
  "task": {
    "id": "task_a1b2c3d4",
    "type": "code.change",
    "createdAt": "2026-04-28T12:00:00Z",
    "deadlineAt": null
  },
  "run": {
    "id": "run_x7y8z9",
    "attempt": 1,
    "correlationId": "corr_m4n5o6"
  },
  "actor": {
    "requestedBy": "orchestrator",
    "agent": "code-writer"
  },
  "repository": {
    "provider": "github",
    "owner": "AnchorageLabs",
    "name": "example-repo",
    "defaultBranch": "main"
  },
  "input": {
    "instruction": "Apply the requested code change",
    "files": ["src/index.ts"]
  },
  "capabilities": [
    "workspace.read",
    "workspace.write"
  ],
  "policy": {
    "humanApprovalRequired": false,
    "maxDurationSeconds": 300
  },
  "context": {
    "parentTaskId": null,
    "priorArtifacts": []
  },
  "secrets": {
    "BUILD_CACHE_TOKEN": { "$ref": "secret://build-cache-token" }
  }
}
```

### 5.2 Field Requirements

| Field | Required | Notes |
|---|---|---|
| `protocolVersion` | MUST | Semver-style string. Agents MUST reject unknown major versions (exit code 2). |
| `task.id` | MUST | Globally unique. Format: `task_` + opaque string. |
| `task.type` | MUST | Dot-separated task type (see &sect;9). |
| `task.createdAt` | MUST | ISO 8601 UTC timestamp. |
| `task.deadlineAt` | MAY | `null` if no deadline. Agents SHOULD respect this if set. |
| `run.id` | MUST | Stable across retries of the same run. |
| `run.attempt` | MUST | Integer >= 1. Incremented on retry. |
| `run.correlationId` | MUST | Opaque string linking the entire workflow. |
| `actor.requestedBy` | MUST | Identifier of the caller (e.g., `"orchestrator"`, `"human:valentin"`). |
| `actor.agent` | MUST | Name of the target agent. |
| `repository` | MAY | Present when the task operates on a repository. |
| `input` | MUST | Task-type-specific payload. May be `{}`. |
| `capabilities` | MUST | List of capabilities granted to the agent for this task. |
| `policy` | MAY | Policy constraints. Agents MUST honour `maxDurationSeconds` if present. |
| `context` | MAY | Upstream context: parent task, prior artifacts. |
| `secrets` | MAY | Secret references. Values MUST be `$ref` URI pointers, not raw secret material. The runtime resolves refs before agent invocation. |

---

## 6. Event Stream

Agents emit events as NDJSON on stdout. Every line MUST be a complete, self-contained JSON object terminated by `\n`.

### 6.1 Common Fields

Every event MUST include:

```json
{
  "protocolVersion": "0.1",
  "eventId": "evt_f1g2h3",
  "runId": "run_x7y8z9",
  "taskId": "task_a1b2c3d4",
  "timestamp": "2026-04-28T12:00:01Z",
  "type": "agent.started",
  "level": "info",
  "message": "code-writer started",
  "data": {}
}
```

| Field | Required | Notes |
|---|---|---|
| `protocolVersion` | MUST | Same as the task envelope version. |
| `eventId` | MUST | Unique per event. Format: `evt_` + opaque string. |
| `runId` | MUST | Copied from `run.id`. |
| `taskId` | MUST | Copied from `task.id`. |
| `timestamp` | MUST | ISO 8601 UTC. |
| `type` | MUST | One of the defined event types. |
| `level` | MUST | One of: `debug`, `info`, `warn`, `error`. |
| `message` | MUST | Human-readable summary. |
| `data` | MUST | Type-specific payload. `{}` if empty. Consumers MUST ignore unknown keys. |

### 6.2 Event Types

#### Lifecycle events

| Type | Terminal? | Description |
|---|---|---|
| `agent.started` | No | MUST be the first event. Confirms the agent received the task and began execution. |
| `agent.progress` | No | Free-form progress update. `data.percent` (0–100) is RECOMMENDED. |
| `agent.heartbeat` | No | Liveness signal. No meaningful `data` required. |
| `agent.completed` | **Yes** | Agent finished successfully. `data` contains the result summary. |
| `agent.failed` | **Yes** | Agent finished with an error. `data.error` MUST describe the failure. |

#### Output events

| Type | Terminal? | Description |
|---|---|---|
| `agent.output` | No | A structured output chunk. `data` contains the payload relevant to the task type. |
| `artifact.created` | No | An artifact was produced. `data` MUST include `artifactType` and `uri`. |

#### Policy events

| Type | Terminal? | Description |
|---|---|---|
| `policy.requested` | No | Agent is requesting a policy decision (e.g., human approval). `data.gate` identifies the gate. |
| `policy.resolved` | No | A policy decision was made. `data.decision` is `"approved"`, `"denied"`, or `"overridden"`. `data.resolvedBy` identifies the decider. |

#### Tool events

| Type | Terminal? | Description |
|---|---|---|
| `tool.requested` | No | Agent is invoking a tool. `data.tool` names the tool, `data.input` describes the call. |
| `tool.result` | No | Tool returned a result. `data.tool` names the tool, `data.output` contains the result. `data.success` is boolean. |

### 6.3 Terminal Event Rules

- Exactly one terminal event (`agent.completed` or `agent.failed`) MUST be emitted before the process exits.
- The terminal event MUST be the **last** event on stdout.
- The terminal event type and the exit code MUST agree: `agent.completed` requires exit code 0; `agent.failed` requires a non-zero exit code.

### 6.4 Observability Requirements

The event stream, taken as a whole, MUST answer:

- **Who/what acted** — `actor` in the envelope, `agent.started` event.
- **What input it saw** — the task envelope (logged by the orchestrator, not re-emitted by the agent).
- **What output it produced** — `agent.output` and `artifact.created` events.
- **What policy allowed it** — `policy.requested` / `policy.resolved` events.
- **What commit/PR/deployment resulted** — `artifact.created` events with appropriate `artifactType`.
- **What human approved or overrode** — `policy.resolved` with `resolvedBy` identifying the human.
- **What model/tool version was used** — `agent.started` event SHOULD include `data.agentVersion` and `data.modelVersion` when applicable.

For AnchorageLabs v0 specifically, policy and human-approval events are forward-compatible protocol definitions only. The v0 orchestrator uses an allow-all policy stub; no v0 workflow emits or waits on `policy.requested` / `policy.resolved`.

---

## 7. Exit Codes

| Code | Meaning | Terminal Event |
|---|---|---|
| 0 | Success | `agent.completed` |
| 1 | Generic failure | `agent.failed` |
| 2 | Invalid input (malformed envelope, unknown protocol version) | `agent.failed` |
| 3 | Unsupported task type | `agent.failed` |
| 4 | Missing capability (agent needs a permission not granted) | `agent.failed` |
| 5 | Policy denied (a required policy gate rejected the action) | `agent.failed` |
| 6 | External dependency failure (API down, network error) | `agent.failed` |
| 7 | Timeout (agent exceeded `maxDurationSeconds` or its own limit) | `agent.failed` |
| 8 | Cancelled (agent received a cancellation signal) | `agent.failed` |
| 9 | Partial success / operator attention required | `agent.failed` |

- Exit codes 10–127 are reserved for future protocol use.
- Exit codes 128+ follow POSIX conventions (128 + signal number).
- If an agent crashes without emitting a terminal event, the orchestrator MUST treat it as exit code 1 and synthesize an `agent.failed` event for the ledger.

---

## 8. Agent Capabilities

Agents declare their capabilities via a manifest file (`agent.json`) at the root of the agent package.

### 8.1 Manifest Schema

```json
{
  "name": "code-writer",
  "version": "0.1.0",
  "protocolVersion": "0.1",
  "description": "Applies a scoped code change and emits a patch artifact.",
  "taskTypes": ["code.change"],
  "inputs": ["change.request"],
  "outputs": ["patch"],
  "requires": ["workspace.read", "workspace.write"],
  "binary": "./bin/code-writer",
  "timeout": 120
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | MUST | Unique agent name. Lowercase, alphanumeric + hyphens. |
| `version` | MUST | Semver. |
| `protocolVersion` | MUST | The protocol version this agent targets. |
| `description` | SHOULD | One-line human-readable purpose. |
| `taskTypes` | MUST | List of `task.type` values this agent handles. |
| `inputs` | SHOULD | Semantic input types the agent expects. |
| `outputs` | SHOULD | Semantic output types the agent produces. |
| `requires` | MUST | Capabilities the agent needs granted at invocation time. |
| `binary` | MUST | Relative path to the executable. |
| `timeout` | MAY | Default max execution time in seconds. Overridden by `policy.maxDurationSeconds`. |

Agent discovery and registry are deferred to v0.2. For v0.1, agents are registered by placing their `agent.json` in a known directory or container image.

---

## 9. Standard v0.1 Task Types

These task types map to the lifecycle workflow defined in AGENTS.md &sect;6. All types have reference implementations in `agents/`.

| Task Type | Purpose | Expected Output | Reference Agent |
|---|---|---|---|
| `issue.triage` | Classify, deduplicate, and scope an issue. Assign labels and priority. | `issue.triage.result` artifact. | `issue-triage` |
| `issue.read` | Read a GitHub issue and extract structured metadata, labels, body, and context. | `issue.summary` artifact. | `issue-reader` |
| `plan.create` | Produce a design/implementation plan from a triaged issue. Post as issue comment. | `implementation.plan` artifact. | `planner` |
| `code.change` | Implement code changes in a sandboxed worktree according to a plan. | `code.change.result` artifact. | `coder` |
| `test.run` | Execute test suites (generated and existing) against the code change. | `test.report` artifact. | `tester` |
| `pull_request.open` | Create a pull request from the working branch to the target branch. | `pr.opened` artifact. | `pr-opener` |
| `ci.watch` | Monitor CI pipeline status on a PR. Report pass/fail. On failure, emit details for retry. | `ci.report` artifact. | `ci-watcher` |
| `review.run` | Run automated review: security, scope, style. Post review comments. | `pr.review.result` artifact. | `reviewer` |
| `merge.prepare` | Verify all gates pass and prepare the PR for merge. | `merge.completed` artifact. | `merge-gate` |
| `deploy.watch` | Monitor a deployment triggered by merge. Report rollout status. | `deployment.record` artifact. | `deploy-watch` |
| `smoke_test.run` | Execute smoke tests against the deployed environment. | `smoke_test.report` artifact. | `smoke-test-runner` |
| `issue.close` | Close the originating issue with a summary comment linking all artifacts. | `issue.closed` artifact. | `issue-closer` |

Custom task types SHOULD use a namespace prefix (e.g., `mycompany.lint.run`). The `anchorage.*` namespace is reserved.

---

## 10. Artifacts

Artifacts are durable outputs referenced by URI. They MUST NOT be embedded inline in events (except for small metadata).

### 10.1 Artifact Reference

```json
{
  "artifactType": "plan",
  "uri": "s3://anchorage-artifacts/run_x7y8z9/plan.md",
  "mediaType": "text/markdown",
  "sizeBytes": 4096,
  "sha256": "a1b2c3..."
}
```

### 10.2 Standard Artifact Types

| Type | Description |
|---|---|
| `issue.summary` | Structured summary of a GitHub issue. |
| `plan` | Implementation plan (Markdown). |
| `patch` | Code diff or patch file. |
| `commit` | A commit SHA. URI format: `git://owner/repo@sha`. |
| `pr.url` | Pull request URL. |
| `test.report` | Test execution results (JSON or JUnit XML). |
| `ci.log` | CI pipeline log excerpt or reference. |
| `review.report` | Automated review findings. |
| `deployment.record` | Deployment ID, environment, timestamp, status. |
| `smoke_test.report` | Smoke test results. |
| `llm.transcript` | Full LLM conversation transcript. MUST be stored externally (not in CloudWatch). |

### 10.3 Rules

- Artifact creation SHOULD be idempotent. Re-running a task with the same `task.id` and `attempt` SHOULD produce the same artifact URI.
- Large artifacts (>1 KB) MUST be stored externally and referenced by URI.
- Artifact URIs MUST be resolvable by the orchestrator. URI scheme conventions are deferred to v0.2.
- `sha256` is RECOMMENDED for integrity verification.

---

## 11. MCP Adapter Mapping

MCP (Model Context Protocol) is used when an agent invokes a **tool** — a discrete capability like reading a file, running a test, or querying a database.

### 11.1 Mapping

| MCP Concept | Anchorage Protocol Equivalent |
|---|---|
| MCP tool call (request) | `tool.requested` event emitted by the agent. |
| MCP tool result (response) | `tool.result` event emitted by the agent after receiving the tool response. |
| MCP resource | Artifact reference or context entry in the task envelope. |
| MCP server | A tool provider. The agent is an MCP client. |

### 11.2 Rules

- MCP MUST NOT become a parallel agent invocation path. Agent-to-agent delegation goes through A2A, not MCP.
- An MCP adapter that wraps an Anchorage agent MUST translate the task envelope into a tool call and the NDJSON stream back into MCP responses.
- MCP tool calls made by an agent during execution SHOULD be recorded as `tool.requested` / `tool.result` event pairs in the agent's stdout stream.

---

## 12. A2A Adapter Mapping

A2A (Agent-to-Agent) is used when an orchestrator or agent **delegates a task** to another agent.

### 12.1 Mapping

| A2A Concept | Anchorage Protocol Equivalent |
|---|---|
| A2A task submission | Delivery of a task envelope to an agent's stdin (or container invocation). |
| A2A streaming updates | NDJSON events on the agent's stdout. |
| A2A task final state | Terminal event (`agent.completed` / `agent.failed`) + exit code. |
| A2A agent card | Agent capability manifest (`agent.json`). |

### 12.2 Rules

- A2A is a **transport adapter** over the protocol lifecycle. It MUST NOT define behaviour that the CLI path cannot express.
- An A2A adapter receiving a task MUST construct a valid task envelope and deliver it to the target agent.
- An A2A adapter MUST stream NDJSON events back to the caller as A2A streaming updates.
- An A2A adapter MUST map the terminal event and exit code to the A2A final task state.

---

## 13. Durability and Idempotency

Workflows in Anchorage span hours or days. The protocol embeds durability primitives so that orchestrators and agents can recover from failures.

### 13.1 Requirements

- Every task MUST have a stable `task.id` assigned before invocation.
- Retries of the same task MUST use the same `task.id` and `run.id` with an incremented `attempt` number.
- Agents SHOULD tolerate duplicate task delivery (same `task.id` + `attempt`). If an agent detects a duplicate, it SHOULD return the previously computed result or re-emit equivalent events.
- Artifact creation SHOULD be idempotent where possible (same input = same artifact at same URI).
- Events are **append-only**. Once emitted, an event MUST NOT be modified or retracted.
- The orchestrator is responsible for:
  - Persisting the event ledger.
  - Sequencing tasks within a run.
  - Enforcing retry policy (max attempts, backoff).
  - Synthesizing `agent.failed` events when agents crash without a terminal event.
- Agents own their **behaviour**. The orchestrator owns the **sequencing and guarantees**. This boundary MUST NOT be crossed.

---

## 14. Security and Policy

### 14.1 Least-Privilege Capabilities

- The task envelope's `capabilities` list is the **granted permission set** for that invocation.
- Agents MUST NOT perform actions beyond their granted capabilities.
- If an agent requires a capability not listed, it MUST exit with code 4 (missing capability).

### 14.2 Secret Handling

- Secrets in the task envelope MUST be `$ref` pointers (e.g., `"secret://github-app-token"`), never raw values.
- The agent runtime (CLI runner or container runtime) resolves secret refs before passing the envelope to the agent process.
- Agents MUST NOT log or emit secret values in events, stderr, or artifacts.
- The resolved secret material MUST NOT appear in the persisted event ledger.

### 14.3 Policy Gates

- Policy gates are expressed as `policy.requested` / `policy.resolved` event pairs.
- The orchestrator evaluates policy externally. In versions that implement gates, the agent emits the request and **blocks** until it receives a resolution (mechanism is runtime-specific, not defined by this spec).
- Human approval events (`policy.resolved` with `resolvedBy` identifying a human) MUST include the identity of the approver.
- Public protocol definitions MUST NOT depend on private orchestrator policy logic. Agents request gates; they do not evaluate them.

AnchorageLabs v0 note: these event types remain in the public protocol so v0.1+ can add gates without a breaking change. No v0 agent emits them, and no v0 workflow waits on them.

### 14.4 Event Hygiene

- Events MUST NOT contain raw secrets, PII beyond what the task requires, or credentials.
- Full LLM transcripts MUST be stored as external artifacts, not inlined in events.

---

## 15. Versioning

### 15.1 Rules

- `protocolVersion` is REQUIRED on every task envelope and every event.
- The version string follows `major.minor` format.
- **Minor version increments** (e.g., 0.1 -> 0.2) MAY add optional fields, new event types, and new task types. Existing fields and types MUST NOT change meaning.
- **Major version increments** (e.g., 0.x -> 1.0) MAY introduce breaking changes to field semantics, remove fields, or change the envelope structure.
- Agents MUST reject envelopes with an unknown **major** version (exit code 2).
- Agents MUST ignore unknown **optional** fields in envelopes and events (forward compatibility).
- Agents encountering an unknown **required** field (i.e., a field that makes the task un-processable) MUST exit with code 2.
- Orchestrators MUST ignore unknown event types and unknown fields in events (forward compatibility).

---

## 16. Minimal End-to-End Example

### 16.1 Task Envelope (`task.json`)

```json
{
  "protocolVersion": "0.1",
  "task": {
    "id": "task_demo_001",
    "type": "code.change",
    "createdAt": "2026-04-28T14:00:00Z",
    "deadlineAt": null
  },
  "run": {
    "id": "run_demo_001",
    "attempt": 1,
    "correlationId": "corr_demo_001"
  },
  "actor": {
    "requestedBy": "orchestrator",
    "agent": "code-writer"
  },
  "repository": {
    "provider": "github",
    "owner": "AnchorageLabs",
    "name": "example-repo",
    "defaultBranch": "main"
  },
  "input": {
    "instruction": "Apply the requested validation change",
    "files": ["src/index.ts"]
  },
  "capabilities": ["workspace.read", "workspace.write"],
  "policy": {},
  "context": {}
}
```

### 16.2 Invocation

```bash
code-writer < task.json
```

### 16.3 stdout (NDJSON event stream)

```jsonl
{"protocolVersion":"0.1","eventId":"evt_001","runId":"run_demo_001","taskId":"task_demo_001","timestamp":"2026-04-28T14:00:01Z","type":"agent.started","level":"info","message":"code-writer v0.1.0 started","data":{"agentVersion":"0.1.0"}}
{"protocolVersion":"0.1","eventId":"evt_002","runId":"run_demo_001","taskId":"task_demo_001","timestamp":"2026-04-28T14:00:02Z","type":"tool.requested","level":"info","message":"Reading target file","data":{"tool":"filesystem.read","input":{"path":"src/index.ts"}}}
{"protocolVersion":"0.1","eventId":"evt_003","runId":"run_demo_001","taskId":"task_demo_001","timestamp":"2026-04-28T14:00:03Z","type":"tool.result","level":"info","message":"Target file read","data":{"tool":"filesystem.read","success":true,"output":{"bytes":128}}}
{"protocolVersion":"0.1","eventId":"evt_004","runId":"run_demo_001","taskId":"task_demo_001","timestamp":"2026-04-28T14:00:03Z","type":"agent.output","level":"info","message":"Patch prepared","data":{"files":["src/index.ts"],"summary":"Applied the requested validation change"}}
{"protocolVersion":"0.1","eventId":"evt_005","runId":"run_demo_001","taskId":"task_demo_001","timestamp":"2026-04-28T14:00:04Z","type":"artifact.created","level":"info","message":"Patch artifact created","data":{"artifactType":"patch","uri":"s3://anchorage-artifacts/run_demo_001/change.patch","mediaType":"text/x-diff","sizeBytes":512}}
{"protocolVersion":"0.1","eventId":"evt_006","runId":"run_demo_001","taskId":"task_demo_001","timestamp":"2026-04-28T14:00:04Z","type":"agent.completed","level":"info","message":"code-writer completed successfully","data":{"artifactType":"patch","uri":"s3://anchorage-artifacts/run_demo_001/change.patch"}}
```

### 16.4 Exit

```
exit code: 0
```

---

## 17. Open Questions for v0.2

The following items are explicitly deferred. They MUST NOT block v0.1 implementation.

| Question | Notes |
|---|---|
| Event signing | Cryptographic signatures on events for tamper evidence. |
| Agent registry / discovery | How agents are registered, versioned, and discovered at runtime. |
| Artifact storage URI conventions | Standardize URI schemes (`s3://`, `git://`, `file://`, etc.). |
| Cancellation protocol | How an agent receives and handles cancellation mid-execution. |
| Resumable agent execution | Checkpoint/resume semantics for long-running agents. |
| Richer policy language | Structured policy rules beyond simple boolean gates. |
| Tool permission negotiation | Dynamic capability requests during execution. |
| SDK language priority beyond TypeScript | Python and Go SDK timelines. |
| Streaming partial outputs | Progressive output for agents that produce incremental results (e.g., code generation). |
| Multi-repository tasks | Tasks that span multiple repositories in a single run. |

---

*This specification is the public Anchorage Protocol v0.1 draft. The machine-readable contract lives in `protocol/schemas/`; examples and conformance test cases live in `protocol/test-cases/`.*
