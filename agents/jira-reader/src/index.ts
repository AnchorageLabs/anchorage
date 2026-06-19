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
const atlassianApiBase = process.env.ATLASSIAN_API_BASE_URL ?? "https://api.atlassian.com";
let eventSequence = 0;

async function main(): Promise<number> {
  const task = parseTask(readFileSync(0, "utf8"));
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "jira.task.read") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `jira-reader only supports jira.task.read, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "jira-reader started", { agentVersion });

  const summary = await readJiraIssue(task.value);
  if (!summary.ok) {
    emit(task.value, "agent.failed", "error", summary.message, {
      error: { code: summary.code, message: summary.message },
    });
    return summary.exitCode;
  }

  emit(task.value, "agent.output", "info", "Jira issue parsed", summary.value);
  const artifact = await writeSummaryArtifact(task.value, summary.value);
  emit(task.value, "artifact.created", "info", "Issue summary artifact created", artifact);
  emit(task.value, "agent.completed", "info", "jira-reader completed successfully", {
    issueKey: summary.value.jiraKey,
    title: summary.value.title,
  });
  return ExitCode.Success;
}

async function readJiraIssue(
  task: TaskEnvelope,
): Promise<{ ok: true; value: IssueSummary } | ReaderFailure> {
  const issueKey = parseIssueKey(task.input.issueKey);
  if (!issueKey) {
    return failure(
      "invalid_issue_key",
      "input.issueKey must be a Jira issue key (e.g. PROJ-123) or a browse URL.",
      ExitCode.InvalidInput,
    );
  }

  const token = process.env.JIRA_TOKEN;
  if (!token) {
    return failure(
      "missing_jira_token",
      "Set JIRA_TOKEN (Atlassian OAuth access token) to read a Jira issue.",
      ExitCode.MissingCapability,
    );
  }

  // Resolve the Atlassian cloud id for the site (3LO tokens are not site-scoped).
  const cloudId = await resolveCloudId(token);
  if (!cloudId.ok) return cloudId;

  const apiPath = `/ex/jira/${cloudId.value}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description,status,labels,reporter`;
  emit(task, "tool.requested", "info", `Fetching Jira issue ${issueKey}`, {
    tool: "jira.issue.get",
    input: { issueKey, cloudId: cloudId.value },
  });

  let issue: JsonObject;
  try {
    issue = await atlassianGet(token, apiPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(task, "tool.result", "error", `Jira issue ${issueKey} fetch failed`, {
      tool: "jira.issue.get",
      success: false,
      error: { code: "jira_issue_read_failed", message },
    });
    return failure("jira_issue_read_failed", message, ExitCode.ExternalDependencyFailure);
  }

  const fields = isObject(issue.fields) ? issue.fields : {};
  const title = readString(fields.summary) ?? "(untitled)";
  const status = isObject(fields.status) ? readString(fields.status.name) : null;
  const state = resolveState(fields);
  const labels = Array.isArray(fields.labels) ? fields.labels.filter(isString) : [];
  const reporter = isObject(fields.reporter) ? readString(fields.reporter.displayName) : null;
  const repository = task.repository ? `${task.repository.owner}/${task.repository.name}` : null;
  const siteUrl = readString(issue.self)?.replace(/\/rest\/api\/.*$/, "");

  const summary: IssueSummary = {
    issueNumber: numberFromKey(issueKey),
    title,
    repository,
    state,
    labels,
    body: adfToText(fields.description),
    url: siteUrl ? `${siteUrl}/browse/${issueKey}` : null,
    author: reporter,
    jiraKey: issueKey,
    jiraStatus: status,
  };

  emit(task, "tool.result", "info", `Jira issue ${issueKey} fetched`, {
    tool: "jira.issue.get",
    success: true,
    output: { title, state, labels },
  });
  return { ok: true, value: summary };
}

async function resolveCloudId(token: string): Promise<{ ok: true; value: string } | ReaderFailure> {
  const preferred = process.env.JIRA_SITE?.trim().toLowerCase();
  try {
    const resources = (await atlassianGetRaw(token, "/oauth/token/accessible-resources")) as Array<{
      id?: string;
      name?: string;
      url?: string;
    }>;
    if (!Array.isArray(resources) || resources.length === 0) {
      return failure(
        "no_jira_site",
        "The Jira connection grants access to no Atlassian sites. Re-authorize the Jira connector.",
        ExitCode.ExternalDependencyFailure,
      );
    }
    const match = preferred
      ? resources.find(
          (r) => r.name?.toLowerCase() === preferred || r.url?.toLowerCase().includes(preferred),
        )
      : undefined;
    const chosen = match ?? resources[0];
    if (!chosen?.id) {
      return failure(
        "no_jira_site",
        "No Atlassian cloud id available.",
        ExitCode.ExternalDependencyFailure,
      );
    }
    return { ok: true, value: chosen.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure("jira_site_lookup_failed", message, ExitCode.ExternalDependencyFailure);
  }
}

/** Accepts a raw key (PROJ-123) or a browse URL (.../browse/PROJ-123). */
function parseIssueKey(value: JsonValue | undefined): null | string {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const candidate = value.trim();
  const fromUrl = candidate.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/i)?.[1];
  const key = (fromUrl ?? candidate).toUpperCase();
  return /^[A-Z][A-Z0-9_]+-\d+$/.test(key) ? key : null;
}

function numberFromKey(key: string): number {
  const n = Number(key.split("-").at(-1));
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function resolveState(fields: JsonObject): string {
  const status = isObject(fields.status) ? fields.status : null;
  const category = status && isObject(status.statusCategory) ? status.statusCategory : null;
  const key = category ? readString(category.key) : null;
  return key === "done" ? "closed" : "open";
}

/** Best-effort flattening of Atlassian Document Format to plain text. */
function adfToText(node: JsonValue | undefined): string {
  if (typeof node === "string") return node;
  if (!isObject(node)) return "";
  const parts: string[] = [];
  const walk = (n: JsonValue): void => {
    if (!isObject(n)) return;
    if (n.type === "text" && typeof n.text === "string") parts.push(n.text);
    if (n.type === "hardBreak" || n.type === "paragraph") parts.push("\n");
    if (Array.isArray(n.content)) for (const child of n.content) walk(child);
  };
  walk(node);
  return parts
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function atlassianGet(token: string, requestPath: string): Promise<JsonObject> {
  const data = await atlassianGetRaw(token, requestPath);
  if (!isObject(data))
    throw new Error(`Atlassian API returned a non-object response on ${requestPath}`);
  return data;
}

async function atlassianGetRaw(token: string, requestPath: string): Promise<JsonValue> {
  const response = await fetch(`${atlassianApiBase}${requestPath}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const data = (await response.json().catch(() => null)) as JsonValue | null;
  if (!response.ok) {
    const apiMessage = isObject(data)
      ? (readString(data.message) ??
        readString((data.errorMessages as JsonValue[] | undefined)?.[0]))
      : null;
    throw new Error(
      `Atlassian API ${response.status} on ${requestPath}: ${apiMessage ?? "request failed"}`,
    );
  }
  return data ?? {};
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
  jiraKey: string;
  jiraStatus: null | string;
};

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
