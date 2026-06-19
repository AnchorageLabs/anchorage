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
const bitbucketApi = process.env.BITBUCKET_API_BASE_URL ?? "https://api.bitbucket.org";
const closedStates = new Set(["resolved", "closed", "invalid", "duplicate", "wontfix"]);
let eventSequence = 0;

async function main(): Promise<number> {
  const task = parseTask(readFileSync(0, "utf8"));
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "bitbucket.task.read") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `bitbucket-reader only supports bitbucket.task.read, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "bitbucket-reader started", { agentVersion });

  const summary = await readBitbucketIssue(task.value);
  if (!summary.ok) {
    emit(task.value, "agent.failed", "error", summary.message, {
      error: { code: summary.code, message: summary.message },
    });
    return summary.exitCode;
  }

  emit(task.value, "agent.output", "info", "Bitbucket issue parsed", summary.value);
  const artifact = await writeSummaryArtifact(task.value, summary.value);
  emit(task.value, "artifact.created", "info", "Issue summary artifact created", artifact);
  emit(task.value, "agent.completed", "info", "bitbucket-reader completed successfully", {
    repo: summary.value.bitbucketRepo,
    id: summary.value.issueNumber,
    title: summary.value.title,
  });
  return ExitCode.Success;
}

async function readBitbucketIssue(
  task: TaskEnvelope,
): Promise<{ ok: true; value: IssueSummary } | ReaderFailure> {
  const ref = parseRef(task.input.issueRef, task.repository);
  if (!ref) {
    return failure(
      "invalid_issue_ref",
      "input.issueRef must be 'workspace/repo#id' or a Bitbucket issue URL (repository fills the repo when only #id is given).",
      ExitCode.InvalidInput,
    );
  }

  const token = process.env.BITBUCKET_TOKEN;
  if (!token) {
    return failure(
      "missing_bitbucket_token",
      "Set BITBUCKET_TOKEN (Bitbucket OAuth access token) to read a Bitbucket issue.",
      ExitCode.MissingCapability,
    );
  }

  const apiPath = `/2.0/repositories/${ref.repo}/issues/${ref.id}`;
  emit(task, "tool.requested", "info", `Fetching Bitbucket issue ${ref.repo}#${ref.id}`, {
    tool: "bitbucket.issue.get",
    input: { repo: ref.repo, id: ref.id },
  });

  let issue: JsonObject;
  try {
    issue = await bitbucketGet(token, apiPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(task, "tool.result", "error", `Bitbucket issue ${ref.repo}#${ref.id} fetch failed`, {
      tool: "bitbucket.issue.get",
      success: false,
      error: { code: "bitbucket_issue_read_failed", message },
    });
    return failure("bitbucket_issue_read_failed", message, ExitCode.ExternalDependencyFailure);
  }

  const title = readString(issue.title) ?? "(untitled)";
  const stateRaw = readString(issue.state)?.toLowerCase() ?? "new";
  const state = closedStates.has(stateRaw) ? "closed" : "open";
  // Bitbucket issues carry no labels; surface kind/priority as labels instead.
  const labels = [readString(issue.kind), readString(issue.priority)].filter(isString);
  const reporter = isObject(issue.reporter)
    ? (readString(issue.reporter.display_name) ?? readString(issue.reporter.nickname))
    : null;
  const body = isObject(issue.content) ? (readString(issue.content.raw) ?? "") : "";
  const url =
    isObject(issue.links) && isObject(issue.links.html) ? readString(issue.links.html.href) : null;
  const id = typeof issue.id === "number" ? issue.id : ref.id;
  const repository = task.repository
    ? `${task.repository.owner}/${task.repository.name}`
    : ref.repo;

  const summary: IssueSummary = {
    issueNumber: id,
    title,
    repository,
    state,
    labels,
    body,
    url,
    author: reporter,
    bitbucketRepo: ref.repo,
  };

  emit(task, "tool.result", "info", `Bitbucket issue ${ref.repo}#${id} fetched`, {
    tool: "bitbucket.issue.get",
    success: true,
    output: { title, state, labels },
  });
  return { ok: true, value: summary };
}

/**
 * Accepts "workspace/repo#id", a bare "#id"/"id" (repo from repository), or a
 * Bitbucket issue URL (https://bitbucket.org/workspace/repo/issues/12/...).
 */
function parseRef(
  value: JsonValue | undefined,
  repository: TaskEnvelope["repository"],
): { repo: string; id: number } | null {
  const repoSlug = repository ? `${repository.owner}/${repository.name}` : null;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const candidate = value.trim();

  const urlMatch = candidate.match(/bitbucket\.org\/([^/]+\/[^/]+)\/issues\/(\d+)/i);
  if (urlMatch?.[1] && urlMatch[2]) {
    return { repo: urlMatch[1], id: Number(urlMatch[2]) };
  }
  const hashMatch = candidate.match(/^(?:(.+?)#)?(\d+)$/);
  if (hashMatch?.[2]) {
    const repo = hashMatch[1] ?? repoSlug;
    if (!repo) return null;
    return { repo, id: Number(hashMatch[2]) };
  }
  return null;
}

async function bitbucketGet(token: string, requestPath: string): Promise<JsonObject> {
  const response = await fetch(`${bitbucketApi}${requestPath}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const data = (await response.json().catch(() => null)) as JsonValue | null;
  if (!response.ok) {
    const apiMessage =
      isObject(data) && isObject(data.error) ? readString(data.error.message) : null;
    throw new Error(
      `Bitbucket API ${response.status} on ${requestPath}: ${apiMessage ?? "request failed"}`,
    );
  }
  if (!isObject(data))
    throw new Error(`Bitbucket API returned a non-object response on ${requestPath}`);
  return data;
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

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
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
  bitbucketRepo: string;
};

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
