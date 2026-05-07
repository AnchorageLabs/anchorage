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

  const plan = createPlan(task.value, issue.value);
  emit(task.value, "agent.output", "info", "Implementation plan created", plan);

  const artifact = await writePlanArtifact(task.value, plan);
  emit(task.value, "artifact.created", "info", "Implementation plan artifact created", artifact);

  emit(task.value, "agent.completed", "info", "planner completed successfully", {
    issueNumber: issue.value.issueNumber,
    title: issue.value.title,
    planId: plan.planId,
  });

  return ExitCode.Success;
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

function createPlan(task: TaskEnvelope, issue: IssueSummary): ImplementationPlan {
  const slug = slugify(issue.title || `issue-${issue.issueNumber}`);
  const labels = issue.labels.map((label) => label.toLowerCase());
  const isBug = labels.some((label) => ["bug", "fix", "defect"].includes(label));
  const isDocs = labels.some((label) => ["docs", "documentation"].includes(label));

  const likelyFiles = inferLikelyFiles(issue, isDocs);
  const verificationCommands = inferVerificationCommands(isDocs);

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
    goal: issue.title,
    branchName: `issue-${issue.issueNumber}-${slug}`,
    summary: summarizeIssue(issue),
    implementationSteps: buildImplementationSteps(isBug, isDocs),
    acceptanceCriteria: buildAcceptanceCriteria(isBug, isDocs),
    likelyFiles,
    verificationCommands,
    risks: buildRisks(issue, likelyFiles),
    handoff: {
      nextAgent: "coder",
      taskType: "code.change",
      instructions:
        "Implement the plan on the suggested branch, keep the diff scoped to the issue, and return changed files, commands run, and any blocker that requires plan revision.",
    },
  };
}

function summarizeIssue(issue: IssueSummary): string {
  const body = issue.body.trim().replace(/\s+/g, " ");
  if (!body) return `Resolve ${issue.repository}#${issue.issueNumber}: ${issue.title}.`;
  const clipped = body.length > 420 ? `${body.slice(0, 417)}...` : body;
  return `Resolve ${issue.repository}#${issue.issueNumber}: ${issue.title}. Issue context: ${clipped}`;
}

function inferLikelyFiles(issue: IssueSummary, isDocs: boolean): string[] {
  const body = issue.body.toLowerCase();
  const title = issue.title.toLowerCase();
  const text = `${title}\n${body}`;
  const files = new Set<string>();

  for (const match of text.matchAll(
    /[`\s]([\w./-]+\.(?:ts|tsx|js|mjs|json|md|yml|yaml))[`\s.,)]/g,
  )) {
    const filePath = match[1];
    if (filePath) files.add(filePath);
  }

  if (text.includes("issue-reader")) files.add("agents/issue-reader/src/index.ts");
  if (text.includes("planner")) files.add("agents/planner/src/index.ts");
  if (text.includes("runner") || text.includes("cli"))
    files.add("cli/anchorage-runner/src/index.ts");
  if (text.includes("protocol")) files.add("protocol/SPEC.md");
  if (isDocs) files.add("README.md");

  if (files.size === 0) files.add("TBD by coder after repository inspection");
  return [...files];
}

function inferVerificationCommands(isDocs: boolean): string[] {
  if (isDocs) return ["corepack pnpm lint"];
  return ["corepack pnpm -r build", "corepack pnpm -r typecheck", "corepack pnpm lint"];
}

function buildImplementationSteps(isBug: boolean, isDocs: boolean): string[] {
  if (isDocs) {
    return [
      "Read the issue and identify the exact public documentation surface that should change.",
      "Update the smallest documentation section that resolves the issue.",
      "Check links, commands, and examples for accuracy.",
      "Keep wording public-safe and free of internal-only details.",
    ];
  }

  if (isBug) {
    return [
      "Reproduce or reason through the reported failure from the issue context.",
      "Locate the smallest code path responsible for the behavior.",
      "Apply a focused fix without broad refactors or compatibility shims unless required.",
      "Run the relevant build and validation commands.",
      "Summarize the behavioral change and any residual risk for the PR.",
    ];
  }

  return [
    "Inspect the relevant package and existing patterns before editing.",
    "Implement the smallest product slice that satisfies the issue.",
    "Persist machine-readable output as artifacts when the change affects agent handoff.",
    "Run the relevant build and validation commands.",
    "Prepare a PR summary that explains the user-visible outcome.",
  ];
}

function buildAcceptanceCriteria(isBug: boolean, isDocs: boolean): string[] {
  if (isDocs) {
    return [
      "The documentation answers the issue without requiring private context.",
      "Commands or examples are copy-pasteable from the repo root when applicable.",
      "No private repository details, internal endpoints, or secrets are exposed.",
    ];
  }

  if (isBug) {
    return [
      "The reported behavior is fixed or clearly narrowed to an external dependency failure.",
      "The fix is scoped to the issue and does not introduce unrelated behavior changes.",
      "Build and typecheck pass for affected workspaces.",
    ];
  }

  return [
    "The requested product behavior exists in the CLI-first path.",
    "The output is structured enough for the next agent to consume without scraping prose.",
    "Build and typecheck pass for affected workspaces.",
  ];
}

function buildRisks(issue: IssueSummary, likelyFiles: string[]): string[] {
  const risks = [
    "The issue may be underspecified; coder should inspect the repository before broad changes.",
  ];
  if (likelyFiles.includes("protocol/SPEC.md")) {
    risks.push("Protocol changes may be architecture-sensitive and require an ADR before landing.");
  }
  if (issue.body.trim().length === 0) {
    risks.push("Issue body is empty, so the plan is based mostly on title and labels.");
  }
  return risks;
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
