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
let eventSequence = 0;

async function main(): Promise<number> {
  const task = parseTask(readFileSync(0, "utf8"));
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "notion.task.read") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `notion-reader only supports notion.task.read, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "notion-reader started", { agentVersion });

  const summary = await readNotionTask(task.value);
  if (!summary.ok) {
    emit(task.value, "agent.failed", "error", summary.message, {
      error: { code: summary.code, message: summary.message },
    });
    return summary.exitCode;
  }

  emit(task.value, "agent.output", "info", "Notion task parsed", summary.value);

  const artifact = await writeSummaryArtifact(task.value, summary.value);
  emit(task.value, "artifact.created", "info", "Issue summary artifact created", artifact);

  emit(task.value, "agent.completed", "info", "notion-reader completed successfully", {
    pageId: summary.value.pageId,
    issueNumber: summary.value.issueNumber,
    title: summary.value.title,
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
    console.error("Invalid task envelope.");
    for (const validationError of result.errors) console.error(JSON.stringify(validationError));
    return { ok: false, exitCode: ExitCode.InvalidInput };
  }
  return { ok: true, value: result.value };
}

async function readNotionTask(
  task: TaskEnvelope,
): Promise<{ ok: true; value: NotionTaskSummary } | ReaderFailure> {
  const pageId = parsePageId(task.input.pageId ?? task.input.pageUrl);
  if (!pageId) {
    return failure(
      "invalid_page_id",
      "input.pageId must be a Notion page id (32 hex chars, dashed or not) or a Notion page URL.",
      ExitCode.InvalidInput,
    );
  }

  const token = process.env.NOTION_TOKEN || process.env.NOTION_API_KEY;
  if (!token) {
    return failure(
      "missing_notion_token",
      "Set NOTION_TOKEN or NOTION_API_KEY to read a Notion page.",
      ExitCode.MissingCapability,
    );
  }

  emit(task, "tool.requested", "info", `Fetching Notion page ${pageId}`, {
    tool: "notion.pages.retrieve",
    input: { page_id: pageId },
  });

  let page: JsonObject;
  try {
    page = await notionGet(token, `/v1/pages/${pageId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(task, "tool.result", "error", `Notion page ${pageId} fetch failed`, {
      tool: "notion.pages.retrieve",
      success: false,
      error: { code: "notion_page_read_failed", message },
    });
    return failure("notion_page_read_failed", message, ExitCode.ExternalDependencyFailure);
  }

  let body = "";
  try {
    body = await readPageBody(token, pageId);
  } catch (error) {
    // Page properties alone are still a usable work item; degrade loudly, not fatally.
    const message = error instanceof Error ? error.message : String(error);
    emit(task, "tool.result", "error", `Notion page ${pageId} content fetch failed`, {
      tool: "notion.blocks.children.list",
      success: false,
      error: { code: "notion_blocks_read_failed", message },
    });
  }

  const properties = isObject(page.properties) ? page.properties : {};
  const title = extractTitle(properties) ?? "(untitled)";
  const uniqueId = extractUniqueId(properties);
  const issueNumber = uniqueId ?? stableNumberFromPageId(pageId);
  const status = extractStatus(properties);
  const state = resolveState(page, status);
  const labels = extractLabels(properties);
  const propertyLines = extractPropertyLines(properties);

  const repository = task.repository
    ? `${task.repository.owner}/${task.repository.name}`
    : extractRepositoryProperty(properties);

  const summary: NotionTaskSummary = {
    issueNumber,
    title,
    repository,
    state,
    labels,
    body: buildBody(body, propertyLines),
    url: readString(page.url),
    author: extractAuthor(page),
    pageId,
    notionStatus: status,
    notionUniqueId: uniqueId,
  };

  if (state === "closed") {
    emit(task, "agent.output", "warn", `Notion task ${pageId} is already done`, {
      warning: {
        code: "notion_task_already_done",
        message: `Notion task "${title}" is archived or marked done (${status ?? "archived"}). Downstream agents will work on a resolved task — verify this is intentional.`,
        pageId,
        state,
      },
    });
  }

  emit(task, "tool.result", "info", `Notion page ${pageId} fetched`, {
    tool: "notion.pages.retrieve",
    success: true,
    output: { title: summary.title, state: summary.state, labels: summary.labels },
  });

  return { ok: true, value: summary };
}

/**
 * Accepts a raw 32-hex id, a dashed UUID, or a Notion page URL
 * (https://www.notion.so/Workspace/Page-Title-<32hex>?v=...). Returns the
 * dashed UUID form the API expects.
 */
function parsePageId(value: JsonValue | undefined): null | string {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const candidate = value.trim();

  const fromUrl = candidate.includes("notion.so")
    ? (candidate.split("?")[0]?.match(/[0-9a-f]{32}(?![0-9a-f])/gi)?.at(-1) ?? null)
    : null;
  const raw = (fromUrl ?? candidate).replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(raw)) return null;

  const hex = raw.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function notionGet(token: string, requestPath: string): Promise<JsonObject> {
  const response = await fetch(`${notionApiBase}${requestPath}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": notionApiVersion,
    },
  });
  const data = (await response.json().catch(() => null)) as JsonValue | null;
  if (!response.ok) {
    const apiMessage = isObject(data) ? readString(data.message) : null;
    throw new Error(`Notion API ${response.status} on ${requestPath}: ${apiMessage ?? "request failed"}`);
  }
  if (!isObject(data)) throw new Error(`Notion API returned a non-object response on ${requestPath}`);
  return data;
}

/** Renders the page's top-level blocks as plain markdown-ish text. */
async function readPageBody(token: string, pageId: string): Promise<string> {
  const lines: string[] = [];
  let cursor: null | string = null;

  do {
    const query = cursor ? `?page_size=100&start_cursor=${cursor}` : "?page_size=100";
    const response: JsonObject = await notionGet(token, `/v1/blocks/${pageId}/children${query}`);
    const blocks = Array.isArray(response.results) ? response.results : [];
    for (const block of blocks) {
      if (!isObject(block)) continue;
      const rendered = renderBlock(block);
      if (rendered !== null) lines.push(rendered);
    }
    cursor = response.has_more === true ? readString(response.next_cursor) : null;
  } while (cursor);

  return lines.join("\n");
}

function renderBlock(block: JsonObject): null | string {
  const type = readString(block.type);
  if (!type) return null;
  const payload = isObject(block[type]) ? (block[type] as JsonObject) : {};
  const text = richTextToPlain(payload.rich_text);

  switch (type) {
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do":
      return `- [${payload.checked === true ? "x" : " "}] ${text}`;
    case "quote":
      return `> ${text}`;
    case "callout":
      return `> ${text}`;
    case "code": {
      const language = readString(payload.language) ?? "";
      return `\`\`\`${language}\n${text}\n\`\`\``;
    }
    case "paragraph":
      return text;
    case "divider":
      return "---";
    default:
      // Unsupported block types (tables, embeds, children of toggles) are
      // skipped rather than rendered as noise.
      return text.length > 0 ? text : null;
  }
}

function richTextToPlain(value: JsonValue | undefined): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => (isObject(item) ? (readString(item.plain_text) ?? "") : ""))
    .join("");
}

function extractTitle(properties: JsonObject): null | string {
  for (const property of Object.values(properties)) {
    if (!isObject(property) || property.type !== "title") continue;
    const title = richTextToPlain(property.title).trim();
    return title.length > 0 ? title : null;
  }
  return null;
}

/**
 * Prefers a Notion `unique_id` property (auto-incrementing "Task ID" column)
 * so branch names and plan references stay human-meaningful.
 */
function extractUniqueId(properties: JsonObject): null | number {
  for (const property of Object.values(properties)) {
    if (!isObject(property) || property.type !== "unique_id") continue;
    if (!isObject(property.unique_id)) continue;
    const number = property.unique_id.number;
    if (typeof number === "number" && Number.isInteger(number) && number > 0) return number;
  }
  return null;
}

/**
 * Pages without a unique_id property still need a stable positive integer for
 * the issue.summary contract (planner derives branch names from it). FNV-1a
 * over the normalized page id is deterministic across runs.
 */
function stableNumberFromPageId(pageId: string): number {
  let hash = 0x811c9dc5;
  for (const char of pageId.replaceAll("-", "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 1) + 1;
}

function extractStatus(properties: JsonObject): null | string {
  for (const property of Object.values(properties)) {
    if (!isObject(property)) continue;
    if (property.type === "status" && isObject(property.status)) {
      return readString(property.status.name);
    }
  }
  for (const [name, property] of Object.entries(properties)) {
    if (!isObject(property)) continue;
    if (property.type === "select" && name.toLowerCase() === "status" && isObject(property.select)) {
      return readString(property.select.name);
    }
  }
  return null;
}

const doneStatusNames = new Set(["done", "complete", "completed", "closed", "shipped"]);

function resolveState(page: JsonObject, status: null | string): string {
  if (page.archived === true || page.in_trash === true) return "closed";
  if (status && doneStatusNames.has(status.toLowerCase())) return "closed";
  return "open";
}

function extractLabels(properties: JsonObject): string[] {
  const labels: string[] = [];
  for (const property of Object.values(properties)) {
    if (!isObject(property) || property.type !== "multi_select") continue;
    if (!Array.isArray(property.multi_select)) continue;
    for (const option of property.multi_select) {
      if (!isObject(option)) continue;
      const name = readString(option.name);
      if (name) labels.push(name);
    }
  }
  return Array.from(new Set(labels));
}

function extractRepositoryProperty(properties: JsonObject): null | string {
  for (const [name, property] of Object.entries(properties)) {
    if (!isObject(property)) continue;
    if (!["repository", "repo"].includes(name.toLowerCase())) continue;
    if (property.type === "rich_text") {
      const value = richTextToPlain(property.rich_text).trim();
      if (/^[^/\s]+\/[^/\s]+$/.test(value)) return value;
    }
    if (property.type === "url") {
      const match = readString(property.url)?.match(/github\.com\/([^/\s]+\/[^/\s?#]+)/);
      if (match?.[1]) return match[1].replace(/\.git$/, "");
    }
  }
  return null;
}

/** Scalar properties become a context appendix so the planner sees them. */
function extractPropertyLines(properties: JsonObject): string[] {
  const lines: string[] = [];
  for (const [name, property] of Object.entries(properties)) {
    if (!isObject(property)) continue;
    const type = readString(property.type);
    if (!type) continue;
    let value: null | string = null;
    if (type === "rich_text") value = richTextToPlain(property.rich_text).trim() || null;
    if (type === "select" && isObject(property.select)) value = readString(property.select.name);
    if (type === "url") value = readString(property.url);
    if (type === "number" && typeof property.number === "number") value = String(property.number);
    if (type === "date" && isObject(property.date)) value = readString(property.date.start);
    if (value) lines.push(`- ${name}: ${value}`);
  }
  return lines;
}

function buildBody(content: string, propertyLines: string[]): string {
  const sections: string[] = [];
  if (content.trim().length > 0) sections.push(content.trim());
  if (propertyLines.length > 0) {
    sections.push(`## Notion properties\n\n${propertyLines.join("\n")}`);
  }
  return sections.join("\n\n");
}

function extractAuthor(page: JsonObject): null | string {
  if (!isObject(page.created_by)) return null;
  return readString(page.created_by.name) ?? readString(page.created_by.id);
}

async function writeSummaryArtifact(task: TaskEnvelope, summary: NotionTaskSummary) {
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

type NotionTaskSummary = ProtocolEvent["data"] & {
  issueNumber: number;
  title: string;
  repository: null | string;
  state: string;
  labels: string[];
  body: string;
  url: null | string;
  author: null | string;
  pageId: string;
  notionStatus: null | string;
  notionUniqueId: null | number;
};

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
