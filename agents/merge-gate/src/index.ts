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

const agentVersion = "0.1.0";
let eventSequence = 0;

type MergeMethod = "merge" | "squash" | "rebase";

interface PrInfo {
  prNumber: number;
  prUrl: string;
  owner: string;
  repo: string;
  headSha: string;
}

interface MergeArtifact {
  prNumber: number;
  prUrl: string;
  merged: boolean;
  mergeMethod: MergeMethod;
  sha: string | null;
  ciStatus: string;
}

async function main(): Promise<number> {
  const rawTask = await readStdin();
  const task = parseTask(rawTask);
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "merge.prepare") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `merge-gate only supports merge.prepare, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "merge-gate started", {
    agentVersion,
  });

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    emit(task.value, "agent.failed", "error", "Missing GitHub token", {
      error: {
        code: "missing_github_token",
        message: "Set GITHUB_TOKEN or GH_TOKEN to interact with GitHub.",
      },
    });
    return ExitCode.MissingCapability;
  }

  const reviewDecision = await resolveReviewDecision(task.value);
  if (reviewDecision !== "approve") {
    const reviewSummary = await resolveReviewSummary(task.value);
    const isChangesRequested = reviewDecision === "changes_requested";
    emit(task.value, "agent.failed", "error", "Review not approved", {
      error: {
        code: "review_not_approved",
        message: `Review decision is "${reviewDecision}", not "approve". Cannot merge.`,
      },
      context: isString(reviewSummary)
        ? {
            decision: reviewDecision,
            nextStep: isChangesRequested
              ? "Address the reviewer's feedback in a new code.change task, then re-run the pipeline from pr-opener onwards."
              : `Review is in state "${reviewDecision}". Resolve the review before retrying merge.`,
            reviewSummary,
          }
        : {
            decision: reviewDecision,
            nextStep: isChangesRequested
              ? "Address the reviewer's feedback in a new code.change task, then re-run the pipeline from pr-opener onwards."
              : `Review is in state "${reviewDecision}". Resolve the review before retrying merge.`,
          },
    });
    return ExitCode.PolicyDenied;
  }

  const prInfo = await resolvePrInfo(task.value, token);
  if (!prInfo.ok) {
    emit(task.value, "agent.failed", "error", prInfo.message, {
      error: {
        code: prInfo.code,
        message: prInfo.message,
      },
    });
    return prInfo.exitCode;
  }

  const pr = prInfo.value;
  const octokit = new Octokit({ auth: token });
  const mergeMethod = resolveMergeMethod();
  const pollIntervalMs = Number(process.env.ANCHORAGE_MERGE_GATE_POLL_INTERVAL_MS) || 10000;
  const maxPolls = Number(process.env.ANCHORAGE_MERGE_GATE_MAX_POLLS) || 30;

  // Prefer a prior ci.report artifact from ci-watcher before polling GitHub.
  const priorCiReport = await readPriorCiReport(task.value);

  let ciResult: CiResult;
  if (priorCiReport) {
    const mappedStatus = mapCiReportStatus(priorCiReport.status);
    emit(task.value, "tool.result", "info", `CI status from prior ci.report: ${mappedStatus}`, {
      tool: "ci.report.artifact",
      success: mappedStatus === "success",
      output: {
        source: "ci.report",
        status: mappedStatus,
        originalStatus: priorCiReport.status,
        uri: priorCiReport.uri,
      },
    });
    ciResult = { status: mappedStatus, pollCount: 0 };
  } else {
    emit(task.value, "tool.requested", "info", "Checking CI status", {
      tool: "github.checks.combined",
      input: {
        owner: pr.owner,
        repo: pr.repo,
        ref: pr.headSha,
      },
    });
    ciResult = await pollCiStatus(octokit, pr, pollIntervalMs, maxPolls);
    emit(task.value, "tool.result", "info", `CI status: ${ciResult.status}`, {
      tool: "github.checks.combined",
      success: ciResult.status === "success",
      output: {
        status: ciResult.status,
        pollCount: ciResult.pollCount,
      },
    });
  }

  if (ciResult.status === "failure") {
    const artifact = await writeArtifact(task.value, {
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      merged: false,
      mergeMethod,
      sha: null,
      ciStatus: "failure",
    });
    emit(task.value, "artifact.created", "info", "Merge artifact created", artifact);
    emit(task.value, "agent.failed", "error", "CI checks failed", {
      error: {
        code: "ci_failed",
        message: "One or more CI checks failed. Cannot merge.",
      },
    });
    return ExitCode.ExternalDependencyFailure;
  }

  if (ciResult.status === "pending") {
    const artifact = await writeArtifact(task.value, {
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      merged: false,
      mergeMethod,
      sha: null,
      ciStatus: "pending",
    });
    emit(task.value, "artifact.created", "info", "Merge artifact created", artifact);
    emit(task.value, "agent.failed", "error", "CI checks timed out", {
      error: {
        code: "ci_failed",
        message: "CI checks did not complete within the polling window.",
      },
    });
    return ExitCode.Timeout;
  }

  emit(task.value, "tool.requested", "info", `Merging PR #${pr.prNumber}`, {
    tool: "github.pulls.merge",
    input: {
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.prNumber,
      merge_method: mergeMethod,
    },
  });

  const mergeResult = await attemptMerge(octokit, pr, mergeMethod);

  emit(task.value, "tool.result", "info", mergeResult.ok ? "Merge succeeded" : "Merge failed", {
    tool: "github.pulls.merge",
    success: mergeResult.ok,
    output: mergeResult.ok
      ? { sha: mergeResult.sha, merged: true }
      : { error: mergeResult.message },
  });

  if (!mergeResult.ok) {
    const artifact = await writeArtifact(task.value, {
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      merged: false,
      mergeMethod,
      sha: null,
      ciStatus: "success",
    });
    emit(task.value, "artifact.created", "info", "Merge artifact created", artifact);
    emit(task.value, "agent.failed", "error", mergeResult.message, {
      error: {
        code: "merge_failed",
        message: mergeResult.message,
      },
    });
    return ExitCode.ExternalDependencyFailure;
  }

  const artifact = await writeArtifact(task.value, {
    prNumber: pr.prNumber,
    prUrl: pr.prUrl,
    merged: true,
    mergeMethod,
    sha: mergeResult.sha,
    ciStatus: "success",
  });

  emit(task.value, "agent.output", "info", "Merge completed", {
    prNumber: pr.prNumber,
    prUrl: pr.prUrl,
    merged: true,
    mergeMethod,
    sha: mergeResult.sha,
  });

  emit(task.value, "artifact.created", "info", "Merge artifact created", artifact);

  emit(task.value, "agent.completed", "info", "merge-gate completed successfully", {
    prNumber: pr.prNumber,
    merged: true,
    sha: mergeResult.sha,
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

async function resolveReviewDecision(task: TaskEnvelope): Promise<string> {
  if (isObject(task.input) && isString((task.input as Record<string, unknown>).reviewDecision)) {
    return (task.input as Record<string, unknown>).reviewDecision as string;
  }

  const artifact = task.context?.priorArtifacts?.find((a) => a.artifactType === "pr.review.result");
  if (!artifact?.uri.startsWith("file://")) return "unknown";

  try {
    const raw = await fs.readFile(new URL(artifact.uri), "utf8");
    const parsed = JSON.parse(raw);
    if (isObject(parsed) && isString((parsed as Record<string, unknown>).decision)) {
      return (parsed as Record<string, unknown>).decision as string;
    }
  } catch {
    // fall through
  }

  return "unknown";
}

async function resolveReviewSummary(task: TaskEnvelope): Promise<null | string> {
  const artifact = task.context?.priorArtifacts?.find((a) => a.artifactType === "pr.review.result");
  if (!artifact?.uri.startsWith("file://")) return null;
  try {
    const raw = await fs.readFile(new URL(artifact.uri), "utf8");
    const parsed = JSON.parse(raw);
    if (isObject(parsed) && isString((parsed as Record<string, unknown>).summary)) {
      return (parsed as Record<string, unknown>).summary as string;
    }
  } catch {
    // fall through
  }
  return null;
}

async function resolvePrInfo(
  task: TaskEnvelope,
  token: string,
): Promise<{ ok: true; value: PrInfo } | PrFailure> {
  let prNumber: number | undefined;
  let prUrl: string | undefined;
  let owner: string | undefined;
  let repo: string | undefined;

  if (isObject(task.input) && isObject((task.input as Record<string, unknown>).pr)) {
    const pr = (task.input as Record<string, unknown>).pr as Record<string, unknown>;
    prNumber = Number(pr.prNumber);
    prUrl = isString(pr.prUrl) ? (pr.prUrl as string) : undefined;
  }

  // Fall back to reading the pr.review.result artifact if prNumber not in input.
  if (!prNumber || !Number.isInteger(prNumber) || prNumber <= 0) {
    const artifact = task.context?.priorArtifacts?.find(
      (a) => a.artifactType === "pr.review.result",
    );
    if (artifact?.uri.startsWith("file://")) {
      try {
        const raw = await fs.readFile(new URL(artifact.uri), "utf8");
        const parsed = JSON.parse(raw);
        if (isObject(parsed)) {
          const p = parsed as Record<string, unknown>;
          prNumber = Number(p.prNumber);
          if (isString(p.prUrl)) prUrl = p.prUrl as string;
        }
      } catch {
        // fall through to validation error
      }
    }
  }

  if (task.repository) {
    owner = task.repository.owner;
    repo = task.repository.name;
  }

  if (!prNumber || !Number.isInteger(prNumber) || prNumber <= 0) {
    return failure(
      "invalid_pr_number",
      "input.pr.prNumber must be a positive integer.",
      ExitCode.InvalidInput,
    );
  }

  if (!owner || !repo) {
    return failure(
      "missing_repository",
      "repository.owner and repository.name are required.",
      ExitCode.InvalidInput,
    );
  }

  const octokit = new Octokit({ auth: token });

  try {
    const response = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    return {
      ok: true,
      value: {
        prNumber,
        prUrl: prUrl ?? response.data.html_url,
        owner,
        repo,
        headSha: response.data.head.sha,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(
      "pr_fetch_failed",
      `Failed to fetch PR #${prNumber}: ${message}`,
      ExitCode.ExternalDependencyFailure,
    );
  }
}

function resolveMergeMethod(): MergeMethod {
  const envMethod = process.env.ANCHORAGE_MERGE_METHOD;
  if (envMethod === "merge" || envMethod === "squash" || envMethod === "rebase") {
    return envMethod;
  }
  return "squash";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface CiResult {
  status: "success" | "failure" | "pending";
  pollCount: number;
}

async function pollCiStatus(
  octokit: Octokit,
  pr: PrInfo,
  pollIntervalMs: number,
  maxPolls: number,
): Promise<CiResult> {
  for (let poll = 1; poll <= maxPolls; poll++) {
    const result = await checkCiStatus(octokit, pr);

    if (result === "success") {
      return { status: "success", pollCount: poll };
    }

    if (result === "failure") {
      return { status: "failure", pollCount: poll };
    }

    if (poll < maxPolls) {
      await sleep(pollIntervalMs);
    }
  }

  return { status: "pending", pollCount: maxPolls };
}

async function checkCiStatus(
  octokit: Octokit,
  pr: PrInfo,
): Promise<"success" | "failure" | "pending"> {
  const [statusResponse, checksResponse] = await Promise.all([
    octokit.repos.getCombinedStatusForRef({
      owner: pr.owner,
      repo: pr.repo,
      ref: pr.headSha,
    }),
    octokit.checks.listForRef({
      owner: pr.owner,
      repo: pr.repo,
      ref: pr.headSha,
    }),
  ]);

  const combinedState = statusResponse.data.state;
  const totalStatuses = statusResponse.data.total_count;
  const checkRuns = checksResponse.data.check_runs;

  // No CI configured at all — treat as success so the merge is not blocked.
  if (totalStatuses === 0 && checkRuns.length === 0) {
    return "success";
  }

  const hasFailedStatus = combinedState === "failure" || combinedState === "error";
  const hasPendingStatus = combinedState === "pending" && totalStatuses > 0;

  const hasFailedCheck = checkRuns.some(
    (run) =>
      run.conclusion === "failure" ||
      run.conclusion === "cancelled" ||
      run.conclusion === "timed_out",
  );
  const hasPendingCheck = checkRuns.some(
    (run) => run.status === "queued" || run.status === "in_progress",
  );

  if (hasFailedStatus || hasFailedCheck) {
    return "failure";
  }

  if (hasPendingStatus || hasPendingCheck) {
    return "pending";
  }

  return "success";
}

interface MergeSuccess {
  ok: true;
  sha: string;
}

interface MergeFailureResult {
  ok: false;
  message: string;
}

async function attemptMerge(
  octokit: Octokit,
  pr: PrInfo,
  mergeMethod: MergeMethod,
): Promise<MergeSuccess | MergeFailureResult> {
  try {
    const response = await octokit.pulls.merge({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.prNumber,
      merge_method: mergeMethod,
    });

    return { ok: true, sha: response.data.sha };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Merge failed for PR #${pr.prNumber}: ${message}` };
  }
}

interface CiReportArtifact {
  status: string;
  uri: string;
}

async function readPriorCiReport(task: TaskEnvelope): Promise<CiReportArtifact | null> {
  const artifact = task.context?.priorArtifacts?.find((a) => a.artifactType === "ci.report");
  if (!artifact?.uri.startsWith("file://")) return null;

  try {
    const raw = await fs.readFile(new URL(artifact.uri), "utf8");
    const parsed = JSON.parse(raw);
    if (isObject(parsed) && isString((parsed as Record<string, unknown>).status)) {
      return {
        status: (parsed as Record<string, unknown>).status as string,
        uri: artifact.uri,
      };
    }
  } catch {
    // Fall through to GitHub polling if the artifact can't be read.
  }

  return null;
}

function mapCiReportStatus(ciReportStatus: string): "success" | "failure" | "pending" {
  if (ciReportStatus === "passed") return "success";
  if (ciReportStatus === "failed" || ciReportStatus === "timed_out") return "failure";
  // Unknown status — treat conservatively as pending so the fallback poll runs if needed.
  return "pending";
}

async function writeArtifact(task: TaskEnvelope, data: MergeArtifact) {
  const artifactRoot =
    process.env.ANCHORAGE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "anchorage-agent-artifacts", task.run.id);
  await fs.mkdir(artifactRoot, { recursive: true });

  const artifactPath = path.join(artifactRoot, "merge-completed.json");
  const content = `${JSON.stringify(data, null, 2)}\n`;
  await fs.writeFile(artifactPath, content, "utf8");

  return {
    artifactType: "merge.completed",
    uri: `file://${artifactPath}`,
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(content),
  };
}

function failure(code: string, message: string, exitCode: number): PrFailure {
  return { ok: false, code, message, exitCode };
}

function isObject(value: unknown): value is Record<string, unknown> {
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

interface AgentFailure {
  ok: false;
  exitCode: number;
}

interface PrFailure extends AgentFailure {
  code: string;
  message: string;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
