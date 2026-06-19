#!/usr/bin/env node
import { readFileSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  ExitCode,
  type ProtocolEvent,
  type TaskEnvelope,
  validateTaskEnvelope,
} from "@anchorage/sdk";

type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonObject | JsonValue[] | boolean | null | number | string;

const agentVersion = "0.1.0";
const linearApi = process.env.LINEAR_API_URL ?? "https://api.linear.app/graphql";
let eventSequence = 0;

async function main(): Promise<number> {
  const task = parseTask(readFileSync(0, "utf8"));
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "linear.task.read") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `linear-reader only supports linear.task.read, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "linear-reader started", { agentVersion });

  const summary = await readLinearIssue(task.value);
  if (!summary.ok) {
    emit(task.value, "agent.failed", "error", summary.message, {
      error: { code: summary.code, message: summary.message },
    });
    return summary.exitCode;
  }

  emit(task.value, "agent.output", "info", "Linear issue parsed", summary.value);
  const artifact = await writeSummaryArtifact(task.value, summary.value);
  emit(task.value, "artifact.created", "info", "Issue summary artifact created", artifact);
  emit(task.value, "agent.completed", "info", "linear-reader completed successfully", {
    identifier: summary.value.linearIdentifier,
    title: summary.value.title,
  });
  return ExitCode.Success;
}

async function readLinearIssue(
  task: TaskEnvelope,
): Promise<{ ok: true; value: IssueSummary } | ReaderFailure> {
  const ref = parseRef(task.input.issueRef);
  if (!ref) {
    return failure(
      "invalid_issue_ref",
      "input.issueRef must be a Linear identifier (ENG-123), an issue id, or a Linear issue URL.",
      ExitCode.InvalidInput,
    );
  }

  const token = process.env.LINEAR_TOKEN;
  if (!token) {
    return failure(
      "missing_linear_token",
      "Set LINEAR_TOKEN (Linear OAuth access token) to read a Linear issue.",
      ExitCode.MissingCapability,
    );
  }

  // Linear's `issue(id:)` resolves both the UUID and the human identifier.
  const query = `query Issue($id: String!) {
    issue(id: $id) {
      identifier
      title
      description
      url
      state { name type }
      labels { nodes { name } }
      creator { name displayName }
    }
  }`;

  emit(task, "tool.requested", "info", `Fetching Linear issue ${ref}`, {
    tool: "linear.issue.get",
    input: { ref },
  });

  let issue: JsonObject;
  try {
    const data = await linearGraphql(token, query, { id: ref });
    const node = isObject(data.issue) ? data.issue : null;
    if (!node) {
      return failure(
        "linear_issue_not_found",
        `Linear returned no issue for "${ref}".`,
        ExitCode.ExternalDependencyFailure,
      );
    }
    issue = node;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(task, "tool.result", "error", `Linear issue ${ref} fetch failed`, {
      tool: "linear.issue.get",
      success: false,
      error: { code: "linear_issue_read_failed", message },
    });
    return failure("linear_issue_read_failed", message, ExitCode.ExternalDependencyFailure);
  }

  const identifier = readString(issue.identifier) ?? ref;
  const title = readString(issue.title) ?? "(untitled)";
  const stateType = isObject(issue.state) ? readString(issue.state.type) : null;
  const stateName = isObject(issue.state) ? readString(issue.state.name) : null;
  const labels = extractLabels(issue.labels);
  const creator = isObject(issue.creator)
    ? (readString(issue.creator.displayName) ?? readString(issue.creator.name))
    : null;
  const repository = task.repository ? `${task.repository.owner}/${task.repository.name}` : null;

  const summary: IssueSummary = {
    issueNumber: numberFromIdentifier(identifier),
    title,
    repository,
    // Linear "completed"/"canceled" state types map to a closed work item.
    state: stateType === "completed" || stateType === "canceled" ? "closed" : "open",
    labels,
    body: readString(issue.description) ?? "",
    url: readString(issue.url),
    author: creator,
    linearIdentifier: identifier,
    linearState: stateName,
  };

  emit(task, "tool.result", "info", `Linear issue ${identifier} fetched`, {
    tool: "linear.issue.get",
    success: true,
    output: { title, state: summary.state, labels },
  });
  return { ok: true, value: summary };
}

/** Accepts an identifier (ENG-123), a UUID, or a Linear issue URL. */
function parseRef(value: JsonValue | undefined): null | string {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const candidate = value.trim();
  const fromUrl = candidate.match(/linear\.app\/[^/]+\/issue\/([A-Z0-9]+-\d+)/i)?.[1];
  return fromUrl ?? candidate;
}

function numberFromIdentifier(identifier: string): number {
  const n = Number(identifier.split("-").at(-1));
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function extractLabels(labels: JsonValue | undefined): string[] {
  if (!isObject(labels) || !Array.isArray(labels.nodes)) return [];
  const names: string[] = [];
  for (const node of labels.nodes) {
    if (isObject(node)) {
      const name = readString(node.name);
      if (name) names.push(name);
    }
  }
  return names;
}

async function linearGraphql(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<JsonObject> {
  const response = await fetch(linearApi, {
    method: "POST",
    // Linear OAuth tokens are sent as a bare Authorization header (no "Bearer ").
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json().catch(() => null)) as JsonValue | null;
  if (!response.ok || !isObject(body)) {
    throw new Error(`Linear API ${response.status}: request failed`);
  }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    const message = isObject(first) ? readString(first.message) : null;
    throw new Error(`Linear GraphQL error: ${message ?? "unknown"}`);
  }
  return isObject(body.data) ? body.data : {};
}

async function writeSummaryArtifact(task: TaskEnvelope, summary: IssueSummary) {
  const artifactRoot =
    process.env.ANCHORAGE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "anchorage-agent-artifacts", task.run.id);
  await fs.mkdir(artifactRoot, { recursive: true });
  const artifactPath = path.join(artifactRoot, "issue-summary.json");
  const content = `${JSON.stringify(summary, null, 2)}\n`;
  await fs.writeFile(artifactPath, content, "utf8");
  return {
    artifactType: "issue.summary",
    uri: `file://${artifactPath}`,
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(content),
  };
}

function parseTask(rawTask: string): { ok: true; value: TaskEnvelope } | AgentFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawTask);
  } catch (error) {
    console.error(`Invalid task JSON: ${(error as Error).message}`);
    return { ok: false, exitCode: ExitCode.InvalidInput };
  }
  const result = validateTaskEnvelope(parsed);
  if (!result.ok) {
    console.error("Invalid task envelope.");
    for (const validationError of result.errors) console.error(JSON.stringify(validationError));
    return { ok: false, exitCode: ExitCode.InvalidInput };
  }
  return { ok: true, value: result.value };
}

function failure(code: string, message: string, exitCode: number): ReaderFailure {
  return { ok: false, code, message, exitCode };
}

function readString(value: JsonValue | undefined): null | string {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emit(
  task: TaskEnvelope,
  type: ProtocolEvent["type"],
  level: ProtocolEvent["level"],
  message: string,
  data: ProtocolEvent["data"],
): void {
  const event: ProtocolEvent = {
    protocolVersion: task.protocolVersion,
    eventId: `evt_${type.replaceAll(".", "_")}_${Date.now()}_${++eventSequence}`,
    runId: task.run.id,
    taskId: task.task.id,
    timestamp: new Date().toISOString(),
    type,
    level,
    message,
    data,
  };
  writeSync(1, `${JSON.stringify(event)}\n`);
}

interface AgentFailure {
  ok: false;
  exitCode: number;
}

interface ReaderFailure extends AgentFailure {
  code: string;
  message: string;
}

type IssueSummary = ProtocolEvent["data"] & {
  issueNumber: number;
  title: string;
  repository: null | string;
  state: string;
  labels: string[];
  body: string;
  url: null | string;
  author: null | string;
  linearIdentifier: string;
  linearState: null | string;
};

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
