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
import { Octokit } from "@octokit/rest";

type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonObject | JsonValue[] | boolean | null | number | string;

const agentVersion = "0.1.0";
let eventSequence = 0;

async function main(): Promise<number> {
  const task = parseTask(readFileSync(0, "utf8"));
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "issue.close") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `issue-closer only supports issue.close, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "issue-closer started", { agentVersion });

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    emit(task.value, "agent.failed", "error", "Missing GitHub token", {
      error: {
        code: "missing_github_token",
        message: "Set GITHUB_TOKEN or GH_TOKEN to close a GitHub issue.",
      },
    });
    return ExitCode.MissingCapability;
  }

  const input = await parseInput(task.value);
  if (!input.ok) return fail(task.value, input);

  const octokit = new Octokit({ auth: token });
  const commentBody = buildComment(input.value);

  if (commentBody) {
    emit(task.value, "tool.requested", "info", `Commenting on issue #${input.value.issueNumber}`, {
      tool: "github.issues.createComment",
      input: {
        owner: input.value.owner,
        repo: input.value.repo,
        issue_number: input.value.issueNumber,
      },
    });

    try {
      await octokit.issues.createComment({
        owner: input.value.owner,
        repo: input.value.repo,
        issue_number: input.value.issueNumber,
        body: commentBody,
      });
      emit(task.value, "tool.result", "info", "Issue summary comment posted", {
        tool: "github.issues.createComment",
        success: true,
        output: { issueNumber: input.value.issueNumber },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit(task.value, "tool.result", "error", "Issue comment failed", {
        tool: "github.issues.createComment",
        success: false,
        error: { code: "github_issue_comment_failed", message },
      });
      return fail(
        task.value,
        failure("github_issue_comment_failed", message, ExitCode.ExternalDependencyFailure),
      );
    }
  }

  emit(task.value, "tool.requested", "info", `Closing issue #${input.value.issueNumber}`, {
    tool: "github.issues.update",
    input: {
      owner: input.value.owner,
      repo: input.value.repo,
      issue_number: input.value.issueNumber,
      state: "closed",
    },
  });

  try {
    const response = await octokit.issues.update({
      owner: input.value.owner,
      repo: input.value.repo,
      issue_number: input.value.issueNumber,
      state: "closed",
    });

    emit(task.value, "tool.result", "info", `Issue #${input.value.issueNumber} closed`, {
      tool: "github.issues.update",
      success: true,
      output: { state: response.data.state, url: response.data.html_url },
    });

    const result: IssueClosedResult = {
      issueNumber: input.value.issueNumber,
      issueUrl: response.data.html_url,
      owner: input.value.owner,
      repo: input.value.repo,
      state: response.data.state,
      closedAt: new Date().toISOString(),
    };

    emit(task.value, "agent.output", "info", "Issue closed", result);
    const artifact = await writeArtifact(task.value, result);
    emit(task.value, "artifact.created", "info", "Issue closed artifact created", artifact);
    emit(task.value, "agent.completed", "info", "issue-closer completed successfully", {
      issueNumber: result.issueNumber,
      issueUrl: result.issueUrl,
      artifact,
    });
    return ExitCode.Success;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(task.value, "tool.result", "error", "Issue close failed", {
      tool: "github.issues.update",
      success: false,
      error: { code: "github_issue_close_failed", message },
    });
    return fail(
      task.value,
      failure("github_issue_close_failed", message, ExitCode.ExternalDependencyFailure),
    );
  }
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
): Promise<{ ok: true; value: IssueCloseInput } | IssueCloserFailure> {
  if (!task.repository) {
    return failure(
      "missing_repository",
      "issue-closer requires repository.owner and repository.name.",
      ExitCode.InvalidInput,
    );
  }

  const issue = isObject(task.input.issue) ? task.input.issue : task.input;
  // In instruction-driven workflows the issue number isn't known when the
  // workflow is built (issue-opener creates it mid-run), so fall back to the
  // issue.opened / issue.summary artifact carried in context.priorArtifacts.
  const issueNumber =
    readPositiveInteger(issue.issueNumber) ??
    readPositiveInteger(issue.number) ??
    (await resolvePriorIssueNumber(task));
  if (!issueNumber) {
    return failure(
      "invalid_issue_number",
      "issue-closer requires input.issue.issueNumber or a prior issue.opened/issue.summary artifact.",
      ExitCode.InvalidInput,
    );
  }

  const summary = isObject(task.input.summary) ? task.input.summary : {};
  const priorSummary = await resolvePriorSummary(task);
  return {
    ok: true,
    value: {
      owner: task.repository.owner,
      repo: task.repository.name,
      issueNumber,
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

async function resolvePriorIssueNumber(task: TaskEnvelope): Promise<number | null> {
  const artifacts = task.context?.priorArtifacts ?? [];
  for (const artifact of artifacts) {
    if (artifact.artifactType !== "issue.opened" && artifact.artifactType !== "issue.summary") {
      continue;
    }
    const data = await readJsonArtifact(artifact.uri);
    const issueNumber = data ? readPositiveInteger(data.issueNumber) : null;
    if (issueNumber) return issueNumber;
  }
  return null;
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

function buildComment(input: IssueCloseInput): null | string {
  const lines: string[] = [];
  lines.push("## Anchorage Run Summary");
  lines.push("");
  lines.push(input.summary ?? "Workflow completed successfully.");
  lines.push("");

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
    lines.push("## Links");
    lines.push("");
    for (const [label, value] of details) lines.push(`- ${label}: ${formatValue(value)}`);
    lines.push("");
  }

  if (input.artifacts.length > 0) {
    lines.push("## Artifacts");
    lines.push("");
    for (const artifact of input.artifacts) lines.push(`- ${formatValue(artifact)}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("*Closed by [issue-closer](https://github.com/AnchorageLabs/anchorage) agent.*");
  return lines.join("\n");
}

function formatValue(value: string): string {
  return value.startsWith("http") ? value : `\`${value}\``;
}

async function writeArtifact(task: TaskEnvelope, result: IssueClosedResult) {
  const artifactRoot =
    process.env.ANCHORAGE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "anchorage-agent-artifacts", task.run.id);
  await fs.mkdir(artifactRoot, { recursive: true });
  const artifactPath = path.join(artifactRoot, "issue-closed.json");
  const content = `${JSON.stringify(result, null, 2)}\n`;
  await fs.writeFile(artifactPath, content, "utf8");
  return {
    artifactType: "issue.closed",
    uri: `file://${artifactPath}`,
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(content),
  };
}

function readPositiveInteger(value: JsonValue | undefined): null | number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
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

function fail(task: TaskEnvelope, failureValue: IssueCloserFailure): number {
  emit(task, "agent.failed", "error", failureValue.message, {
    error: { code: failureValue.code, message: failureValue.message },
  });
  return failureValue.exitCode;
}

function failure(code: string, message: string, exitCode: number): IssueCloserFailure {
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

interface IssueCloserFailure extends AgentFailure {
  code: string;
  message: string;
}

interface IssueCloseInput {
  owner: string;
  repo: string;
  issueNumber: number;
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

type IssueClosedResult = ProtocolEvent["data"] & {
  issueNumber: number;
  issueUrl: string;
  owner: string;
  repo: string;
  state: string;
  closedAt: string;
};

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
