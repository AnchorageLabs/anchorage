#!/usr/bin/env node
import { readFileSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { llmEventInput, requestLlmCompletion, resolveLlmConfig } from "@anchorage/agent-llm";
import {
  ExitCode,
  type ProtocolEvent,
  type TaskEnvelope,
  validateTaskEnvelope,
} from "@anchorage/sdk";
import { Octokit } from "@octokit/rest";

type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonObject | JsonValue[] | boolean | null | number | string;

const agentVersion = "0.1.0";
let eventSequence = 0;

async function main(): Promise<number> {
  const task = parseTask(readFileSync(0, "utf8"));
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "issue.triage") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `issue-triage only supports issue.triage, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "issue-triage started", { agentVersion });

  const llmConfig = resolveLlmConfig({
    role: "triage",
    anthropicModel: "claude-sonnet-4-6",
    bedrockModel: "us.anthropic.claude-sonnet-4-6",
    openaiModel: "gpt-4o",
  });

  if (!llmConfig.ok) {
    emit(task.value, "agent.failed", "error", "Missing LLM credentials", {
      error: {
        code: "missing_llm_api_key",
        message: llmConfig.message,
      },
    });
    return ExitCode.MissingCapability;
  }

  const issue = await resolveIssueSummary(task.value);
  if (!issue.ok) {
    emit(task.value, "agent.failed", "error", issue.message, {
      error: { code: issue.code, message: issue.message },
    });
    return issue.exitCode;
  }

  emit(task.value, "tool.requested", "info", "Requesting triage decision from LLM", {
    tool: llmConfig.value.tool,
    input: llmEventInput(llmConfig.value, { issueNumber: issue.value.issueNumber }),
  });

  const completion = await requestLlmCompletion(llmConfig.value, {
    system: triageSystemPrompt(),
    user: triageUserPrompt(issue.value),
    temperature: 0.1,
  });

  if (!completion.ok) {
    emit(task.value, "tool.result", "error", "LLM triage request failed", {
      tool: llmConfig.value.tool,
      success: false,
      error: { code: "llm_request_failed", message: completion.message },
    });
    emit(task.value, "agent.failed", "error", completion.message, {
      error: { code: "llm_request_failed", message: completion.message },
    });
    return ExitCode.ExternalDependencyFailure;
  }

  const rawTriage = parseTriageJson(completion.value.text);
  if (!rawTriage.ok) {
    emit(task.value, "agent.failed", "error", rawTriage.message, {
      error: { code: "invalid_llm_triage_json", message: rawTriage.message },
    });
    return ExitCode.ExternalDependencyFailure;
  }

  emit(task.value, "tool.result", "info", "LLM triage decision received", {
    tool: llmConfig.value.tool,
    success: true,
    output: {
      provider: llmConfig.value.provider,
      model: llmConfig.value.model,
      stopReason: completion.value.stopReason,
      usage: {
        inputTokens: completion.value.inputTokens,
        outputTokens: completion.value.outputTokens,
      },
    },
  });

  const str = (v: JsonValue | undefined, fallback: string): string =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : fallback;

  const triageResult: TriageResult = {
    issueNumber: issue.value.issueNumber,
    issueTitle: issue.value.title,
    repository: issue.value.repository,
    scope: str(rawTriage.value.scope, "unclear"),
    type: str(rawTriage.value.type, "unknown"),
    priority: str(rawTriage.value.priority, "medium"),
    readiness: str(rawTriage.value.readiness, "needs-detail"),
    agentEligible: rawTriage.value.agentEligible === true,
    suggestedLabels: Array.isArray(rawTriage.value.suggestedLabels)
      ? rawTriage.value.suggestedLabels.filter(isString)
      : [],
    reasoning: str(rawTriage.value.reasoning, ""),
    triageId: `triage_${task.value.run.id}_${issue.value.issueNumber}`,
  };

  // Optionally apply labels when github.write is granted and a token is available.
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const hasGithubWrite =
    Array.isArray(task.value.capabilities) && task.value.capabilities.includes("github.write");

  if (hasGithubWrite && token && task.value.repository && triageResult.suggestedLabels.length > 0) {
    await applyLabels(task.value, token, triageResult);
  } else if (triageResult.suggestedLabels.length > 0) {
    emit(
      task.value,
      "agent.output",
      "info",
      "Label application skipped (no github.write capability)",
      {
        suggestedLabels: triageResult.suggestedLabels,
      },
    );
  }

  emit(task.value, "agent.output", "info", "Triage decision produced", triageResult);
  const artifact = await writeArtifact(task.value, triageResult);
  emit(task.value, "artifact.created", "info", "Triage result artifact created", artifact);
  emit(task.value, "agent.completed", "info", "issue-triage completed successfully", {
    issueNumber: triageResult.issueNumber,
    triageId: triageResult.triageId,
    agentEligible: triageResult.agentEligible,
    priority: triageResult.priority,
  });

  return ExitCode.Success;
}

// ── LLM ──────────────────────────────────────────────────────────────────────

function triageSystemPrompt(): string {
  return `You are Anchorage triage, a triage agent in a CLI-first multi-agent software workflow.
Return only strict JSON. Do not wrap it in markdown.
Classify the issue and decide whether it is ready for autonomous implementation.
The JSON shape must be:
{
  "scope": "bug" | "feature" | "refactor" | "docs" | "chore" | "unclear",
  "type": "backend" | "frontend" | "cli" | "infra" | "protocol" | "test" | "mixed" | "unknown",
  "priority": "critical" | "high" | "medium" | "low",
  "readiness": "ready" | "needs-detail" | "blocked" | "out-of-scope",
  "agentEligible": boolean,
  "suggestedLabels": string[],
  "reasoning": string
}
Rules:
- agentEligible: true only when readiness is "ready" and the issue is specific enough for autonomous coding.
- suggestedLabels: short GitHub label names (e.g. "bug", "enhancement", "good first issue"). Empty array if none.
- reasoning: one concise paragraph explaining the triage decision.`;
}

function triageUserPrompt(issue: IssueSummary): string {
  return JSON.stringify(
    {
      task: "Triage this GitHub issue.",
      issue: {
        number: issue.issueNumber,
        title: issue.title,
        repository: issue.repository,
        state: issue.state,
        labels: issue.labels,
        body: issue.body,
        author: issue.author,
      },
    },
    null,
    2,
  );
}

function parseTriageJson(
  text: string,
): { ok: true; value: JsonObject } | { ok: false; message: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    return { ok: false, message: "LLM response did not contain a JSON object." };
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, message: "LLM triage JSON was not an object." };
    }
    return { ok: true, value: parsed as JsonObject };
  } catch (error) {
    return { ok: false, message: `LLM triage JSON was invalid: ${(error as Error).message}` };
  }
}

// ── GitHub label application ──────────────────────────────────────────────────

async function applyLabels(task: TaskEnvelope, token: string, triage: TriageResult): Promise<void> {
  if (!task.repository) return;
  const { owner, name: repo } = task.repository;
  const octokit = new Octokit({ auth: token });

  emit(task, "tool.requested", "info", `Applying labels to issue #${triage.issueNumber}`, {
    tool: "github.issues.addLabels",
    input: { owner, repo, issue_number: triage.issueNumber, labels: triage.suggestedLabels },
  });

  try {
    // Ensure labels exist first (create if missing).
    for (const label of triage.suggestedLabels) {
      await octokit.issues.createLabel({ owner, repo, name: label, color: "ededed" }).catch(() => {
        // Label may already exist — ignore.
      });
    }
    await octokit.issues.addLabels({
      owner,
      repo,
      issue_number: triage.issueNumber,
      labels: triage.suggestedLabels,
    });
    emit(task, "tool.result", "info", "Labels applied", {
      tool: "github.issues.addLabels",
      success: true,
      output: { labels: triage.suggestedLabels },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(task, "tool.result", "error", "Label application failed", {
      tool: "github.issues.addLabels",
      success: false,
      error: { code: "github_label_failed", message },
    });
    // Non-fatal — triage result is still valid even if label write failed.
  }
}

// ── Issue summary resolution ──────────────────────────────────────────────────

async function resolveIssueSummary(
  task: TaskEnvelope,
): Promise<{ ok: true; value: IssueSummary } | TriageFailure> {
  const direct = parseIssueSummary(task.input.issue ?? task.input);
  if (direct.ok) return direct;

  const artifact = task.context?.priorArtifacts?.find((a) => a.artifactType === "issue.summary");
  if (!artifact?.uri.startsWith("file://")) {
    return failure(
      "missing_issue_summary",
      "issue-triage requires input.issue or a prior issue.summary artifact.",
      ExitCode.InvalidInput,
    );
  }

  try {
    const raw = await fs.readFile(new URL(artifact.uri), "utf8");
    const parsed = parseIssueSummary(JSON.parse(raw));
    if (!parsed.ok) {
      return failure(
        "invalid_issue_summary",
        "issue.summary artifact shape is invalid.",
        ExitCode.InvalidInput,
      );
    }
    return parsed;
  } catch (error) {
    return failure(
      "issue_summary_read_failed",
      `Could not read issue.summary: ${(error as Error).message}`,
      ExitCode.InvalidInput,
    );
  }
}

function parseIssueSummary(value: unknown): { ok: true; value: IssueSummary } | { ok: false } {
  if (!isObject(value)) return { ok: false };
  const issueNumber = Number(value.issueNumber);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return { ok: false };
  if (typeof value.title !== "string") return { ok: false };
  if (typeof value.body !== "string") return { ok: false };
  return {
    ok: true,
    value: {
      issueNumber,
      title: value.title,
      repository: typeof value.repository === "string" ? value.repository : "",
      state: typeof value.state === "string" ? value.state : "open",
      labels: Array.isArray(value.labels) ? value.labels.filter(isString) : [],
      body: value.body,
      url: typeof value.url === "string" ? value.url : null,
      author: typeof value.author === "string" ? value.author : null,
    },
  };
}

// ── Artifact ──────────────────────────────────────────────────────────────────

async function writeArtifact(task: TaskEnvelope, result: TriageResult) {
  const artifactRoot =
    process.env.ANCHORAGE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "anchorage-agent-artifacts", task.run.id);
  await fs.mkdir(artifactRoot, { recursive: true });
  const artifactPath = path.join(artifactRoot, "triage-result.json");
  const content = `${JSON.stringify(result, null, 2)}\n`;
  await fs.writeFile(artifactPath, content, "utf8");
  return {
    artifactType: "issue.triage.result",
    uri: `file://${artifactPath}`,
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(content),
  };
}

// ── Util ──────────────────────────────────────────────────────────────────────

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
    for (const e of result.errors) console.error(JSON.stringify(e));
    return { ok: false, exitCode: ExitCode.InvalidInput };
  }
  return { ok: true, value: result.value };
}

function failure(code: string, message: string, exitCode: number): TriageFailure {
  return { ok: false, code, message, exitCode };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
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

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentFailure {
  ok: false;
  exitCode: number;
}

interface TriageFailure extends AgentFailure {
  code: string;
  message: string;
}

type IssueSummary = {
  issueNumber: number;
  title: string;
  repository: string;
  state: string;
  labels: string[];
  body: string;
  url: null | string;
  author: null | string;
};

type TriageResult = ProtocolEvent["data"] & {
  issueNumber: number;
  issueTitle: string;
  repository: string;
  scope: string;
  type: string;
  priority: string;
  readiness: string;
  agentEligible: boolean;
  suggestedLabels: string[];
  reasoning: string;
  triageId: string;
};

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
