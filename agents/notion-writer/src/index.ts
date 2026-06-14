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
const notionApiBase = process.env.NOTION_API_BASE_URL ?? "https://api.notion.com";
const notionApiVersion = process.env.NOTION_VERSION ?? "2022-06-28";
// Notion caps a single rich_text text object at 2000 characters.
const notionTextChunkSize = 2000;
let eventSequence = 0;

async function main(): Promise<number> {
  const task = parseTask(readFileSync(0, "utf8"));
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "notion.task.update") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `notion-writer only supports notion.task.update, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "notion-writer started", { agentVersion });

  const token = process.env.NOTION_TOKEN || process.env.NOTION_API_KEY;
  if (!token) {
    emit(task.value, "agent.failed", "error", "Missing Notion token", {
      error: {
        code: "missing_notion_token",
        message: "Set NOTION_TOKEN or NOTION_API_KEY to update a Notion page.",
      },
    });
    return ExitCode.MissingCapability;
  }

  const input = await parseInput(task.value);
  if (!input.ok) return fail(task.value, input);

  const commentBody = buildComment(input.value);
  if (commentBody) {
    emit(task.value, "tool.requested", "info", `Commenting on Notion page ${input.value.pageId}`, {
      tool: "notion.comments.create",
      input: { page_id: input.value.pageId },
    });

    try {
      await notionRequest(token, "POST", "/v1/comments", {
        parent: { page_id: input.value.pageId },
        rich_text: toRichText(commentBody),
      });
      emit(task.value, "tool.result", "info", "Workflow summary comment posted", {
        tool: "notion.comments.create",
        success: true,
        output: { pageId: input.value.pageId },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit(task.value, "tool.result", "error", "Notion comment failed", {
        tool: "notion.comments.create",
        success: false,
        error: { code: "notion_comment_failed", message },
      });
      return fail(
        task.value,
        failure("notion_comment_failed", message, ExitCode.ExternalDependencyFailure),
      );
    }
  }

  let statusApplied: null | string = null;
  if (input.value.status) {
    const statusResult = await updateStatus(token, task.value, input.value);
    if (!statusResult.ok) return fail(task.value, statusResult);
    statusApplied = statusResult.value;
  }

  const result: NotionTaskUpdatedResult = {
    pageId: input.value.pageId,
    pageUrl: input.value.pageUrl,
    commentPosted: commentBody !== null,
    status: statusApplied,
    updatedAt: new Date().toISOString(),
  };

  emit(task.value, "agent.output", "info", "Notion task updated", result);
  const artifact = await writeArtifact(task.value, result);
  emit(task.value, "artifact.created", "info", "Notion task updated artifact created", artifact);
  emit(task.value, "agent.completed", "info", "notion-writer completed successfully", {
    pageId: result.pageId,
    status: result.status,
    artifact,
  });
  return ExitCode.Success;
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
    for (const validationError of result.errors) console.error(JSON.stringify(validationError));
    return { ok: false, exitCode: ExitCode.InvalidInput };
  }
  return { ok: true, value: result.value };
}

async function parseInput(
  task: TaskEnvelope,
): Promise<{ ok: true; value: NotionUpdateInput } | WriterFailure> {
  const page = isObject(task.input.page) ? task.input.page : task.input;
  const pageId = parsePageId(page.pageId ?? page.pageUrl) ?? (await resolvePriorPageId(task));
  if (!pageId) {
    return failure(
      "invalid_page_id",
      "notion-writer requires input.page.pageId (or pageUrl), or a prior issue.summary artifact carrying a pageId.",
      ExitCode.InvalidInput,
    );
  }

  const summary = isObject(task.input.summary) ? task.input.summary : {};
  const priorSummary = await resolvePriorSummary(task);
  return {
    ok: true,
    value: {
      pageId,
      pageUrl: readString(page.pageUrl),
      status: readString(task.input.status),
      statusProperty: readString(task.input.statusProperty),
      summary: readString(summary.text) ?? readString(task.input.summaryText) ?? priorSummary.text,
      prUrl: readString(summary.prUrl) ?? readString(task.input.prUrl) ?? priorSummary.prUrl,
      commitSha:
        readString(summary.commitSha) ?? readString(task.input.commitSha) ?? priorSummary.commitSha,
      testReportUri: readString(summary.testReportUri) ?? priorSummary.testReportUri,
      ciReportUri: readString(summary.ciReportUri) ?? priorSummary.ciReportUri,
      deploymentUri: readString(summary.deploymentUri) ?? priorSummary.deploymentUri,
      smokeTestUri: readString(summary.smokeTestUri) ?? priorSummary.smokeTestUri,
      artifacts: mergeStrings(readStringArray(summary.artifacts), priorSummary.artifacts),
    },
  };
}

async function resolvePriorPageId(task: TaskEnvelope): Promise<null | string> {
  const artifacts = task.context?.priorArtifacts ?? [];
  for (const artifact of artifacts) {
    if (artifact.artifactType !== "issue.summary") continue;
    const data = await readJsonArtifact(artifact.uri);
    const pageId = data ? parsePageId(data.pageId) : null;
    if (pageId) return pageId;
  }
  return null;
}

async function resolvePriorSummary(task: TaskEnvelope): Promise<WorkflowSummaryInput> {
  const artifacts = task.context?.priorArtifacts ?? [];
  const summary: WorkflowSummaryInput = {
    text: null,
    prUrl: null,
    commitSha: null,
    testReportUri: null,
    ciReportUri: null,
    deploymentUri: null,
    smokeTestUri: null,
    artifacts: artifacts.map((artifact) => artifact.uri),
  };

  for (const artifact of artifacts) {
    if (artifact.artifactType === "test.report") summary.testReportUri = artifact.uri;
    if (artifact.artifactType === "ci.report") summary.ciReportUri = artifact.uri;
    if (artifact.artifactType === "deployment.record") summary.deploymentUri = artifact.uri;
    if (artifact.artifactType === "smoke_test.report") summary.smokeTestUri = artifact.uri;

    const data = await readJsonArtifact(artifact.uri);
    if (!data) continue;

    if (artifact.artifactType === "pr.opened") {
      summary.prUrl ??= readString(data.prUrl);
    }
    if (artifact.artifactType === "merge.completed") {
      summary.prUrl ??= readString(data.prUrl);
      summary.commitSha ??= readString(data.sha);
    }
  }

  return summary;
}

async function readJsonArtifact(uri: string): Promise<JsonObject | null> {
  if (!uri.startsWith("file://")) return null;
  try {
    const raw = await fs.readFile(new URL(uri), "utf8");
    const parsed = JSON.parse(raw);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Finds the page's status-type property (or a select property matching
 * input.statusProperty / "Status") and sets it to the requested option.
 */
async function updateStatus(
  token: string,
  task: TaskEnvelope,
  input: NotionUpdateInput,
): Promise<{ ok: true; value: string } | WriterFailure> {
  const status = input.status ?? "";
  emit(task, "tool.requested", "info", `Setting status on Notion page ${input.pageId}`, {
    tool: "notion.pages.update",
    input: { page_id: input.pageId, status },
  });

  try {
    const page = await notionRequest(token, "GET", `/v1/pages/${input.pageId}`);
    const properties = isObject(page.properties) ? page.properties : {};
    const target = findStatusProperty(properties, input.statusProperty);
    if (!target) {
      const wanted = input.statusProperty ?? "a status-type property or a select named 'Status'";
      throw new Error(`Page has no writable status property (looked for ${wanted}).`);
    }

    const value: JsonObject =
      target.type === "status" ? { status: { name: status } } : { select: { name: status } };
    await notionRequest(token, "PATCH", `/v1/pages/${input.pageId}`, {
      properties: { [target.name]: value },
    });

    emit(task, "tool.result", "info", `Notion page status set to ${status}`, {
      tool: "notion.pages.update",
      success: true,
      output: { pageId: input.pageId, property: target.name, status },
    });
    return { ok: true, value: status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(task, "tool.result", "error", "Notion status update failed", {
      tool: "notion.pages.update",
      success: false,
      error: { code: "notion_status_update_failed", message },
    });
    return failure("notion_status_update_failed", message, ExitCode.ExternalDependencyFailure);
  }
}

function findStatusProperty(
  properties: JsonObject,
  requestedName: null | string,
): null | { name: string; type: "select" | "status" } {
  for (const [name, property] of Object.entries(properties)) {
    if (!isObject(property)) continue;
    if (requestedName && name.toLowerCase() !== requestedName.toLowerCase()) continue;
    if (property.type === "status") return { name, type: "status" };
  }
  for (const [name, property] of Object.entries(properties)) {
    if (!isObject(property) || property.type !== "select") continue;
    const matches = requestedName
      ? name.toLowerCase() === requestedName.toLowerCase()
      : name.toLowerCase() === "status";
    if (matches) return { name, type: "select" };
  }
  return null;
}

function buildComment(input: NotionUpdateInput): null | string {
  const lines: string[] = [];
  lines.push("Anchorage Run Summary");
  lines.push("");
  lines.push(input.summary ?? "Workflow completed successfully.");

  const details = [
    ["Pull request", input.prUrl],
    ["Commit", input.commitSha],
    ["Test report", input.testReportUri],
    ["CI report", input.ciReportUri],
    ["Deployment", input.deploymentUri],
    ["Smoke test", input.smokeTestUri],
  ].filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
  );

  if (details.length > 0) {
    lines.push("");
    for (const [label, value] of details) lines.push(`${label}: ${value}`);
  }

  if (input.artifacts.length > 0) {
    lines.push("");
    lines.push("Artifacts:");
    for (const artifact of input.artifacts) lines.push(`- ${artifact}`);
  }

  lines.push("");
  lines.push("Posted by the notion-writer agent (AnchorageLabs/anchorage).");
  return lines.join("\n");
}

function toRichText(content: string): Array<{ text: { content: string } }> {
  const chunks: Array<{ text: { content: string } }> = [];
  for (let offset = 0; offset < content.length; offset += notionTextChunkSize) {
    chunks.push({ text: { content: content.slice(offset, offset + notionTextChunkSize) } });
  }
  return chunks;
}

function parsePageId(value: JsonValue | undefined): null | string {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const candidate = value.trim();

  const fromUrl = candidate.includes("notion.so")
    ? (candidate
        .split("?")[0]
        ?.match(/[0-9a-f]{32}(?![0-9a-f])/gi)
        ?.at(-1) ?? null)
    : null;
  const raw = (fromUrl ?? candidate).replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(raw)) return null;

  const hex = raw.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function notionRequest(
  token: string,
  method: "GET" | "PATCH" | "POST",
  requestPath: string,
  body?: JsonObject,
): Promise<JsonObject> {
  const response = await fetch(`${notionApiBase}${requestPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": notionApiVersion,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await response.json().catch(() => null)) as JsonValue | null;
  if (!response.ok) {
    const apiMessage = isObject(data) ? readString(data.message) : null;
    throw new Error(
      `Notion API ${response.status} on ${requestPath}: ${apiMessage ?? "request failed"}`,
    );
  }
  if (!isObject(data))
    throw new Error(`Notion API returned a non-object response on ${requestPath}`);
  return data;
}

async function writeArtifact(task: TaskEnvelope, result: NotionTaskUpdatedResult) {
  const artifactRoot =
    process.env.ANCHORAGE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "anchorage-agent-artifacts", task.run.id);
  await fs.mkdir(artifactRoot, { recursive: true });
  const artifactPath = path.join(artifactRoot, "notion-task-updated.json");
  const content = `${JSON.stringify(result, null, 2)}\n`;
  await fs.writeFile(artifactPath, content, "utf8");
  return {
    artifactType: "notion.task.updated",
    uri: `file://${artifactPath}`,
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(content),
  };
}

function readString(value: JsonValue | undefined): null | string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function mergeStrings(first: string[], second: string[]): string[] {
  return Array.from(new Set([...first, ...second]));
}

function fail(task: TaskEnvelope, failureValue: WriterFailure): number {
  emit(task, "agent.failed", "error", failureValue.message, {
    error: { code: failureValue.code, message: failureValue.message },
  });
  return failureValue.exitCode;
}

function failure(code: string, message: string, exitCode: number): WriterFailure {
  return { ok: false, code, message, exitCode };
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

interface WriterFailure extends AgentFailure {
  code: string;
  message: string;
}

interface NotionUpdateInput {
  pageId: string;
  pageUrl: null | string;
  status: null | string;
  statusProperty: null | string;
  summary: null | string;
  prUrl: null | string;
  commitSha: null | string;
  testReportUri: null | string;
  ciReportUri: null | string;
  deploymentUri: null | string;
  smokeTestUri: null | string;
  artifacts: string[];
}

interface WorkflowSummaryInput {
  text: null | string;
  prUrl: null | string;
  commitSha: null | string;
  testReportUri: null | string;
  ciReportUri: null | string;
  deploymentUri: null | string;
  smokeTestUri: null | string;
  artifacts: string[];
}

type NotionTaskUpdatedResult = ProtocolEvent["data"] & {
  pageId: string;
  pageUrl: null | string;
  commentPosted: boolean;
  status: null | string;
  updatedAt: string;
};

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
