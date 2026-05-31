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
  const rawTask = await readStdin();
  const task = parseTask(rawTask);
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "plan.create") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `planner only supports plan.create, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "planner started", { agentVersion });

  const issue = await resolveIssueSummary(task.value);
  if (!issue.ok) {
    emit(task.value, "agent.failed", "error", issue.message, {
      error: { code: issue.code, message: issue.message },
    });
    return issue.exitCode;
  }

  const planResult = await createPlan(task.value, issue.value);
  if (!planResult.ok) {
    emit(task.value, "agent.failed", "error", planResult.message, {
      error: { code: planResult.code, message: planResult.message },
    });
    return planResult.exitCode;
  }

  const plan = planResult.value;
  emit(task.value, "agent.output", "info", "Implementation plan created", plan);

  const artifact = await writePlanArtifact(task.value, plan);
  emit(task.value, "artifact.created", "info", "Implementation plan artifact created", artifact);

  // Post a plan summary comment to the source issue when github.write is granted.
  await maybePostPlanComment(task.value, issue.value, plan);

  emit(task.value, "agent.completed", "info", "planner completed successfully", {
    issueNumber: issue.value.issueNumber,
    title: issue.value.title,
    planId: plan.planId,
  });

  return ExitCode.Success;
}

async function maybePostPlanComment(
  task: TaskEnvelope,
  issue: IssueSummary,
  plan: ImplementationPlan,
): Promise<void> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const hasGithubWrite =
    Array.isArray(task.capabilities) && task.capabilities.includes("github.write");
  if (!hasGithubWrite || !token || !task.repository) return;

  const { owner, name: repo } = task.repository;
  const body = buildPlanComment(plan);

  emit(task, "tool.requested", "info", `Posting plan comment to issue #${issue.issueNumber}`, {
    tool: "github.issues.createComment",
    input: { owner, repo, issue_number: issue.issueNumber },
  });

  try {
    const octokit = new Octokit({ auth: token });
    await octokit.issues.createComment({ owner, repo, issue_number: issue.issueNumber, body });
    emit(task, "tool.result", "info", "Plan comment posted", {
      tool: "github.issues.createComment",
      success: true,
      output: { issueNumber: issue.issueNumber },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(task, "tool.result", "error", "Plan comment failed (non-fatal)", {
      tool: "github.issues.createComment",
      success: false,
      error: { code: "github_comment_failed", message },
    });
    // Non-fatal — plan artifact is already written.
  }
}

function buildPlanComment(plan: ImplementationPlan): string {
  const lines: string[] = [];
  lines.push("## Anchorage Plan");
  lines.push("");
  lines.push(`**Goal:** ${plan.goal}`);
  lines.push(`**Branch:** \`${plan.branchName}\``);
  lines.push(`**Plan ID:** \`${plan.planId}\``);
  lines.push("");
  lines.push("### Steps");
  lines.push("");
  for (const step of plan.implementationSteps) {
    lines.push(`- ${step}`);
  }
  lines.push("");
  lines.push("### Acceptance criteria");
  lines.push("");
  for (const criterion of plan.acceptanceCriteria) {
    lines.push(`- ${criterion}`);
  }
  if (plan.risks.length > 0) {
    lines.push("");
    lines.push("### Risks");
    lines.push("");
    for (const risk of plan.risks) {
      lines.push(`- ${risk}`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("*Posted by [planner](https://github.com/AnchorageLabs/anchorage) agent.*");
  return lines.join("\n");
}

async function readStdin(): Promise<string> {
  return readFileSync(0, "utf8");
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
    for (const validationError of result.errors) {
      console.error(JSON.stringify(validationError));
    }
    return { ok: false, exitCode: ExitCode.InvalidInput };
  }

  return { ok: true, value: result.value };
}

async function resolveIssueSummary(
  task: TaskEnvelope,
): Promise<{ ok: true; value: IssueSummary } | PlannerFailure> {
  const directIssue = parseIssueSummary(task.input.issue);
  if (directIssue.ok) return directIssue;

  const artifact = task.context?.priorArtifacts?.find(
    (candidate) => candidate.artifactType === "issue.summary",
  );
  if (!artifact) {
    return failure(
      "missing_issue_summary",
      "planner requires input.issue or a prior issue.summary artifact.",
      ExitCode.InvalidInput,
    );
  }

  if (!artifact.uri.startsWith("file://")) {
    return failure(
      "unsupported_artifact_uri",
      "planner currently supports local file:// issue.summary artifacts only.",
      ExitCode.InvalidInput,
    );
  }

  let rawArtifact: string;
  try {
    rawArtifact = await fs.readFile(new URL(artifact.uri), "utf8");
  } catch (error) {
    return failure(
      "issue_summary_read_failed",
      `Could not read issue.summary artifact: ${(error as Error).message}`,
      ExitCode.InvalidInput,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArtifact);
  } catch (error) {
    return failure(
      "invalid_issue_summary_json",
      `issue.summary artifact is not valid JSON: ${(error as Error).message}`,
      ExitCode.InvalidInput,
    );
  }

  const artifactIssue = parseIssueSummary(parsed);
  if (!artifactIssue.ok) {
    return failure(
      "invalid_issue_summary",
      "issue.summary artifact must include issueNumber, title, repository, state, labels, body, url, and author.",
      ExitCode.InvalidInput,
    );
  }

  return artifactIssue;
}

function parseIssueSummary(value: unknown): { ok: true; value: IssueSummary } | { ok: false } {
  if (!isObject(value)) return { ok: false };

  const issueNumber = Number(value.issueNumber);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return { ok: false };
  if (typeof value.title !== "string") return { ok: false };
  if (typeof value.repository !== "string") return { ok: false };
  if (typeof value.state !== "string") return { ok: false };
  if (!Array.isArray(value.labels)) return { ok: false };
  if (typeof value.body !== "string") return { ok: false };

  return {
    ok: true,
    value: {
      issueNumber,
      title: value.title,
      repository: value.repository,
      state: value.state,
      labels: value.labels.filter(isString),
      body: value.body,
      url: typeof value.url === "string" ? value.url : null,
      author: typeof value.author === "string" ? value.author : null,
    },
  };
}

async function createPlan(
  task: TaskEnvelope,
  issue: IssueSummary,
): Promise<{ ok: true; value: ImplementationPlan } | PlannerFailure> {
  const config = resolveLlmConfig({
    role: "planner",
    anthropicModel: "claude-sonnet-4-6",
    bedrockModel: "us.anthropic.claude-sonnet-4-6",
    openaiModel: "gpt-4.1",
  });
  if (!config.ok) {
    return failure("missing_llm_api_key", config.message, ExitCode.MissingCapability);
  }

  emit(task, "tool.requested", "info", "Requesting implementation plan from LLM", {
    tool: config.value.tool,
    input: llmEventInput(config.value, { issueNumber: issue.issueNumber }),
  });

  const response = await requestLlmCompletion(config.value, {
    system: plannerSystemPrompt(),
    user: plannerUserPrompt(issue),
    maxTokens: 2400,
    temperature: 0.2,
  });
  if (!response.ok) {
    emitLlmFailure(task, config.value.tool, response.message);
    return failure("llm_request_failed", response.message, ExitCode.ExternalDependencyFailure);
  }

  const rawPlan = parsePlanJson(response.value.text);
  if (!rawPlan.ok) {
    emitLlmFailure(task, config.value.tool, rawPlan.message);
    return failure("invalid_llm_plan_json", rawPlan.message, ExitCode.ExternalDependencyFailure);
  }

  const plan = normalizePlan(task, issue, rawPlan.value);
  emit(task, "tool.result", "info", "LLM implementation plan received", {
    tool: config.value.tool,
    success: true,
    output: {
      ...llmEventInput(config.value),
      stopReason: response.value.stopReason,
      inputTokens: response.value.inputTokens,
      outputTokens: response.value.outputTokens,
    },
  });

  return { ok: true, value: plan };
}

function plannerSystemPrompt(): string {
  return `You are Anchorage planner, a planning agent in a CLI-first multi-agent software workflow.
Your output is consumed by a coder agent, not by a human.
Return only strict JSON. Do not wrap it in markdown.
Design the smallest product-oriented plan that can resolve the issue.
Do not invent private context. Prefer repository inspection by the coder when uncertain.
Do not propose tests as standalone files unless the issue clearly requires them.
The JSON shape must be:
{
  "goal": string,
  "branchName": string,
  "summary": string,
  "implementationSteps": string[],
  "acceptanceCriteria": string[],
  "likelyFiles": string[],
  "verificationCommands": string[],
  "risks": string[],
  "handoffInstructions": string
}`;
}

function plannerUserPrompt(issue: IssueSummary): string {
  return JSON.stringify(
    {
      task: "Create an implementation plan for the coder agent.",
      issue: {
        number: issue.issueNumber,
        title: issue.title,
        repository: issue.repository,
        state: issue.state,
        labels: issue.labels,
        body: issue.body,
        url: issue.url,
        author: issue.author,
      },
      constraints: [
        "Return only JSON matching the requested shape.",
        "The coder will inspect the repository and write code after this plan.",
        "Keep the plan focused on shipping the product behavior quickly.",
        "No testing-only or documentation-only detours unless necessary for the issue.",
      ],
    },
    null,
    2,
  );
}

function parsePlanJson(
  value: string,
): { ok: true; value: JsonObject } | { ok: false; message: string } {
  const json = extractJsonObject(value);
  if (!json) return { ok: false, message: "LLM response did not contain a JSON object." };
  try {
    const parsed = JSON.parse(json);
    if (!isObject(parsed)) return { ok: false, message: "LLM plan JSON was not an object." };
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, message: `LLM plan JSON was invalid: ${(error as Error).message}` };
  }
}

function extractJsonObject(value: string): null | string {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return value.slice(start, end + 1);
}

function normalizePlan(
  task: TaskEnvelope,
  issue: IssueSummary,
  rawPlan: JsonObject,
): ImplementationPlan {
  const branchName = buildBranchName(
    issue.issueNumber,
    stringValue(rawPlan.branchName, slugify(issue.title)),
    task.run.id,
  );
  return {
    planId: `plan_${task.run.id}_${issue.issueNumber}`,
    issue: {
      issueNumber: issue.issueNumber,
      title: issue.title,
      repository: issue.repository,
      url: issue.url,
      author: issue.author,
      labels: issue.labels,
    },
    goal: stringValue(rawPlan.goal, issue.title),
    branchName,
    summary: stringValue(rawPlan.summary, `Plan for ${issue.repository}#${issue.issueNumber}.`),
    implementationSteps: stringArrayValue(rawPlan.implementationSteps),
    acceptanceCriteria: stringArrayValue(rawPlan.acceptanceCriteria),
    likelyFiles: stringArrayValue(rawPlan.likelyFiles),
    verificationCommands: stringArrayValue(rawPlan.verificationCommands),
    risks: stringArrayValue(rawPlan.risks),
    handoff: {
      nextAgent: "coder",
      taskType: "code.change",
      instructions: stringValue(
        rawPlan.handoffInstructions,
        "Implement this plan, keep changes scoped, and report blockers that require plan revision.",
      ),
    },
  };
}

function stringValue(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function buildBranchName(issueNumber: number, rawBranchName: string, runId: string): string {
  const prefixMatch = rawBranchName.match(/^(feat|fix|chore|docs|refactor|test)\//);
  const prefix = prefixMatch?.[1] ?? "fix";
  const rawSlug = rawBranchName
    .replace(/^refs\/heads\//, "")
    .replace(/^(feat|fix|chore|docs|refactor|test)\//, "")
    .replace(/^issue-\d+[-_/]*/, "");
  const slug = slugify(rawSlug) || "changes";
  const runSuffix = slugify(runId).slice(-12) || String(Date.now());
  return `${prefix}/issue-${issueNumber}-${slug}-${runSuffix}`;
}

function stringArrayValue(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isString)
    .map((entry) => entry.trim())
    .filter(isString);
}

function emitLlmFailure(task: TaskEnvelope, tool: string, message: string): void {
  // The protocol schema requires tool.result events to carry `output`; the
  // failure detail lives inside it so the event still validates.
  emit(task, "tool.result", "error", "LLM implementation plan failed", {
    tool,
    success: false,
    output: { error: { code: "llm_plan_failed", message } },
  });
}

async function writePlanArtifact(task: TaskEnvelope, plan: ImplementationPlan) {
  const artifactRoot =
    process.env.ANCHORAGE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "anchorage-agent-artifacts", task.run.id);
  await fs.mkdir(artifactRoot, { recursive: true });

  const artifactPath = path.join(artifactRoot, "implementation-plan.json");
  const content = `${JSON.stringify(plan, null, 2)}\n`;
  await fs.writeFile(artifactPath, content, "utf8");

  return {
    artifactType: "implementation.plan",
    uri: `file://${artifactPath}`,
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(content),
  };
}

function failure(code: string, message: string, exitCode: number): PlannerFailure {
  return { ok: false, code, message, exitCode };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "work";
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

interface PlannerFailure extends AgentFailure {
  code: string;
  message: string;
}

type IssueSummary = JsonObject & {
  issueNumber: number;
  title: string;
  repository: string;
  state: string;
  labels: string[];
  body: string;
  url: null | string;
  author: null | string;
};

type ImplementationPlan = ProtocolEvent["data"] & {
  planId: string;
  issue: JsonObject & {
    issueNumber: number;
    title: string;
    repository: string;
    url: null | string;
    author: null | string;
    labels: string[];
  };
  goal: string;
  branchName: string;
  summary: string;
  implementationSteps: string[];
  acceptanceCriteria: string[];
  likelyFiles: string[];
  verificationCommands: string[];
  risks: string[];
  handoff: JsonObject & {
    nextAgent: string;
    taskType: string;
    instructions: string;
  };
};

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
