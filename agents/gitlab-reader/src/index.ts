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
let eventSequence = 0;

function gitlabBase(): string {
  return (process.env.GITLAB_BASE_URL?.trim() || "https://gitlab.com").replace(/\/+$/, "");
}

async function main(): Promise<number> {
  const task = parseTask(readFileSync(0, "utf8"));
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "gitlab.task.read") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `gitlab-reader only supports gitlab.task.read, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "gitlab-reader started", { agentVersion });

  const summary = await readGitlabIssue(task.value);
  if (!summary.ok) {
    emit(task.value, "agent.failed", "error", summary.message, {
      error: { code: summary.code, message: summary.message },
    });
    return summary.exitCode;
  }

  emit(task.value, "agent.output", "info", "GitLab issue parsed", summary.value);
  const artifact = await writeSummaryArtifact(task.value, summary.value);
  emit(task.value, "artifact.created", "info", "Issue summary artifact created", artifact);
  emit(task.value, "agent.completed", "info", "gitlab-reader completed successfully", {
    project: summary.value.gitlabProject,
    iid: summary.value.issueNumber,
    title: summary.value.title,
  });
  return ExitCode.Success;
}

async function readGitlabIssue(
  task: TaskEnvelope,
): Promise<{ ok: true; value: IssueSummary } | ReaderFailure> {
  const ref = parseRef(task.input.issueRef, task.repository);
  if (!ref) {
    return failure(
      "invalid_issue_ref",
      "input.issueRef must be 'group/project#iid' or a GitLab issue URL (repository fills the project when only #iid is given).",
      ExitCode.InvalidInput,
    );
  }

  const token = process.env.GITLAB_TOKEN;
  if (!token) {
    return failure(
      "missing_gitlab_token",
      "Set GITLAB_TOKEN (GitLab OAuth access token) to read a GitLab issue.",
      ExitCode.MissingCapability,
    );
  }

  const projectId = encodeURIComponent(ref.project);
  const apiPath = `/api/v4/projects/${projectId}/issues/${ref.iid}`;
  emit(task, "tool.requested", "info", `Fetching GitLab issue ${ref.project}#${ref.iid}`, {
    tool: "gitlab.issue.get",
    input: { project: ref.project, iid: ref.iid },
  });

  let issue: JsonObject;
  try {
    issue = await gitlabGet(token, apiPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(task, "tool.result", "error", `GitLab issue ${ref.project}#${ref.iid} fetch failed`, {
      tool: "gitlab.issue.get",
      success: false,
      error: { code: "gitlab_issue_read_failed", message },
    });
    return failure("gitlab_issue_read_failed", message, ExitCode.ExternalDependencyFailure);
  }

  const title = readString(issue.title) ?? "(untitled)";
  const state = readString(issue.state) === "closed" ? "closed" : "open";
  const labels = Array.isArray(issue.labels) ? issue.labels.filter(isString) : [];
  const author = isObject(issue.author) ? readString(issue.author.username) : null;
  const iid = typeof issue.iid === "number" ? issue.iid : ref.iid;
  const repository = task.repository
    ? `${task.repository.owner}/${task.repository.name}`
    : ref.project;

  const summary: IssueSummary = {
    issueNumber: iid,
    title,
    repository,
    state,
    labels,
    body: readString(issue.description) ?? "",
    url: readString(issue.web_url),
    author,
    gitlabProject: ref.project,
  };

  emit(task, "tool.result", "info", `GitLab issue ${ref.project}#${iid} fetched`, {
    tool: "gitlab.issue.get",
    success: true,
    output: { title, state, labels },
  });
  return { ok: true, value: summary };
}

/**
 * Accepts "group/project#iid", a bare "#iid"/"iid" (project from repository), or
 * a GitLab issue URL (https://gitlab.com/group/project/-/issues/12).
 */
function parseRef(
  value: JsonValue | undefined,
  repository: TaskEnvelope["repository"],
): { project: string; iid: number } | null {
  const repoProject = repository ? `${repository.owner}/${repository.name}` : null;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const candidate = value.trim();

  const urlMatch = candidate.match(/gitlab[^/]*\/(.+?)\/-\/issues\/(\d+)/i);
  if (urlMatch?.[1] && urlMatch[2]) {
    return { project: urlMatch[1], iid: Number(urlMatch[2]) };
  }
  const hashMatch = candidate.match(/^(?:(.+?)#)?(\d+)$/);
  if (hashMatch?.[2]) {
    const project = hashMatch[1] ?? repoProject;
    if (!project) return null;
    return { project, iid: Number(hashMatch[2]) };
  }
  return null;
}

async function gitlabGet(token: string, requestPath: string): Promise<JsonObject> {
  const response = await fetch(`${gitlabBase()}${requestPath}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const data = (await response.json().catch(() => null)) as JsonValue | null;
  if (!response.ok) {
    const apiMessage = isObject(data) ? (readString(data.message) ?? readString(data.error)) : null;
    throw new Error(
      `GitLab API ${response.status} on ${requestPath}: ${apiMessage ?? "request failed"}`,
    );
  }
  if (!isObject(data))
    throw new Error(`GitLab API returned a non-object response on ${requestPath}`);
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
  gitlabProject: string;
};

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
