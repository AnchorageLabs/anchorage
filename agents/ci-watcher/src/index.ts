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
type CiStatus = "passed" | "failed" | "pending" | "timed_out";

const agentVersion = "0.1.0";
let eventSequence = 0;

async function main(): Promise<number> {
  const task = parseTask(readFileSync(0, "utf8"));
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "ci.watch") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `ci-watcher only supports ci.watch, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "ci-watcher started", { agentVersion });

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    emit(task.value, "agent.failed", "error", "Missing GitHub token", {
      error: {
        code: "missing_github_token",
        message: "Set GITHUB_TOKEN or GH_TOKEN to read GitHub checks and statuses.",
      },
    });
    return ExitCode.MissingCapability;
  }

  const input = await parseInput(task.value);
  if (!input.ok) return fail(task.value, input);

  const octokit = new Octokit({ auth: token });
  const prInfo = await fetchPrInfo(octokit, input.value);
  if (!prInfo.ok) return fail(task.value, prInfo);

  emit(task.value, "tool.requested", "info", `Watching CI for PR #${prInfo.value.prNumber}`, {
    tool: "github.checks.combined",
    input: {
      owner: prInfo.value.owner,
      repo: prInfo.value.repo,
      pull_number: prInfo.value.prNumber,
      ref: prInfo.value.headSha,
      pollIntervalMs: input.value.pollIntervalMs,
      maxPolls: input.value.maxPolls,
    },
  });

  const report = await pollCi(
    octokit,
    prInfo.value,
    input.value.pollIntervalMs,
    input.value.maxPolls,
  );

  emit(
    task.value,
    "tool.result",
    report.status === "passed" ? "info" : "error",
    "CI watch finished",
    {
      tool: "github.checks.combined",
      success: report.status === "passed",
      output: report,
    },
  );

  emit(
    task.value,
    "agent.output",
    report.status === "passed" ? "info" : "error",
    "CI report prepared",
    report,
  );

  const artifact = await writeArtifact(task.value, report);
  emit(task.value, "artifact.created", "info", "CI report artifact created", artifact);

  if (report.status === "passed") {
    emit(task.value, "agent.completed", "info", "ci-watcher completed successfully", {
      status: report.status,
      artifact,
    });
    return ExitCode.Success;
  }

  if (report.status === "timed_out") {
    emit(task.value, "agent.failed", "error", "CI checks timed out", {
      error: {
        code: "ci_timed_out",
        message: "CI checks did not reach a terminal state within the polling window.",
      },
      artifact,
    });
    return ExitCode.Timeout;
  }

  emit(task.value, "agent.failed", "error", "CI checks failed", {
    error: {
      code: "ci_failed",
      message: "One or more CI checks or statuses failed.",
    },
    artifact,
  });
  return ExitCode.PartialSuccessAttentionRequired;
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
): Promise<{ ok: true; value: CiWatchInput } | CiWatcherFailure> {
  if (!task.repository) {
    return failure(
      "missing_repository",
      "ci-watcher requires repository.owner and repository.name.",
      ExitCode.InvalidInput,
    );
  }

  const prNumber = await resolvePrNumber(task);
  if (!prNumber.ok) return prNumber;

  return {
    ok: true,
    value: {
      owner: task.repository.owner,
      repo: task.repository.name,
      prNumber: prNumber.value,
      pollIntervalMs:
        readPositiveInteger(task.input.pollIntervalMs) ??
        readEnvInteger("ANCHORAGE_CI_WATCH_POLL_INTERVAL_MS") ??
        10000,
      maxPolls:
        readPositiveInteger(task.input.maxPolls) ??
        readEnvInteger("ANCHORAGE_CI_WATCH_MAX_POLLS") ??
        30,
    },
  };
}

async function resolvePrNumber(
  task: TaskEnvelope,
): Promise<{ ok: true; value: number } | CiWatcherFailure> {
  const pr = isObject(task.input.pr) ? task.input.pr : task.input;
  const prNumber = Number(readNumber(pr.prNumber) ?? readNumber(pr.number));

  if (Number.isInteger(prNumber) && prNumber > 0) {
    return { ok: true, value: prNumber };
  }

  const artifact = task.context?.priorArtifacts?.find((a) => a.artifactType === "pr.opened");
  if (!artifact) {
    return failure(
      "invalid_pr_number",
      "ci-watcher requires input.pr.prNumber or a prior pr.opened artifact.",
      ExitCode.InvalidInput,
    );
  }

  if (artifact.uri.startsWith("file://")) {
    try {
      const raw = await fs.readFile(new URL(artifact.uri), "utf8");
      const parsed = JSON.parse(raw);
      const parsedPr = isObject(parsed) ? Number(readNumber(parsed.prNumber)) : Number.NaN;
      if (Number.isInteger(parsedPr) && parsedPr > 0) return { ok: true, value: parsedPr };
    } catch (error) {
      return failure(
        "pr_artifact_read_failed",
        `Could not read pr.opened artifact: ${(error as Error).message}`,
        ExitCode.InvalidInput,
      );
    }

    return failure(
      "invalid_pr_artifact",
      "pr.opened artifact must include a valid prNumber.",
      ExitCode.InvalidInput,
    );
  }

  const urlMatch = artifact.uri.match(/\/pull\/(\d+)/);
  if (urlMatch?.[1]) return { ok: true, value: Number(urlMatch[1]) };

  return failure(
    "invalid_pr_artifact",
    "Could not extract PR number from pr.opened artifact.",
    ExitCode.InvalidInput,
  );
}

async function fetchPrInfo(
  octokit: Octokit,
  input: CiWatchInput,
): Promise<{ ok: true; value: PrInfo } | CiWatcherFailure> {
  try {
    const response = await octokit.pulls.get({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.prNumber,
    });
    return {
      ok: true,
      value: {
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
        prUrl: response.data.html_url,
        headSha: response.data.head.sha,
        headRef: response.data.head.ref,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(
      "pr_fetch_failed",
      `Failed to fetch PR #${input.prNumber}: ${message}`,
      ExitCode.ExternalDependencyFailure,
    );
  }
}

async function pollCi(
  octokit: Octokit,
  pr: PrInfo,
  pollIntervalMs: number,
  maxPolls: number,
): Promise<CiReport> {
  let lastReport: CiReport | null = null;
  for (let poll = 1; poll <= maxPolls; poll++) {
    const report = await readCi(octokit, pr, poll);
    lastReport = report;
    if (report.status === "passed" || report.status === "failed") return report;
    if (poll < maxPolls) await sleep(pollIntervalMs);
  }

  return { ...(lastReport ?? emptyReport(pr, maxPolls)), status: "timed_out" };
}

async function readCi(octokit: Octokit, pr: PrInfo, pollCount: number): Promise<CiReport> {
  const [statusResponse, checksResponse] = await Promise.all([
    octokit.repos.getCombinedStatusForRef({ owner: pr.owner, repo: pr.repo, ref: pr.headSha }),
    octokit.checks.listForRef({ owner: pr.owner, repo: pr.repo, ref: pr.headSha }),
  ]);

  const statuses = statusResponse.data.statuses.map((status) => ({
    name: status.context,
    state: status.state,
    description: status.description,
    targetUrl: status.target_url,
  }));
  const checkRuns = checksResponse.data.check_runs.map((check) => ({
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
    detailsUrl: check.details_url,
    startedAt: check.started_at,
    completedAt: check.completed_at,
  }));

  const failedStatuses = statuses.filter(
    (status) => status.state === "failure" || status.state === "error",
  );
  const failedCheckRuns = checkRuns.filter(
    (check) =>
      check.conclusion === "failure" ||
      check.conclusion === "cancelled" ||
      check.conclusion === "timed_out" ||
      check.conclusion === "action_required",
  );
  const pendingStatuses = statuses.filter((status) => status.state === "pending");
  const pendingCheckRuns = checkRuns.filter(
    (check) => check.status === "queued" || check.status === "in_progress",
  );

  let status: CiStatus = "passed";
  if (failedStatuses.length > 0 || failedCheckRuns.length > 0) status = "failed";
  else if (pendingStatuses.length > 0 || pendingCheckRuns.length > 0) status = "pending";

  return {
    status,
    prNumber: pr.prNumber,
    prUrl: pr.prUrl,
    owner: pr.owner,
    repo: pr.repo,
    headSha: pr.headSha,
    headRef: pr.headRef,
    observedAt: new Date().toISOString(),
    pollCount,
    summary: summarize(status, failedStatuses, failedCheckRuns, pendingStatuses, pendingCheckRuns),
    statuses,
    checkRuns,
    failedChecks: [...failedStatuses, ...failedCheckRuns].map((check) => ({
      name: check.name,
      conclusion: "state" in check ? check.state : check.conclusion,
      url: "targetUrl" in check ? check.targetUrl : check.detailsUrl,
    })),
  };
}

function emptyReport(pr: PrInfo, pollCount: number): CiReport {
  return {
    status: "pending",
    prNumber: pr.prNumber,
    prUrl: pr.prUrl,
    owner: pr.owner,
    repo: pr.repo,
    headSha: pr.headSha,
    headRef: pr.headRef,
    observedAt: new Date().toISOString(),
    pollCount,
    summary: "No CI status was observed.",
    statuses: [],
    checkRuns: [],
    failedChecks: [],
  };
}

function summarize(
  status: CiStatus,
  failedStatuses: StatusSummary[],
  failedCheckRuns: CheckRunSummary[],
  pendingStatuses: StatusSummary[],
  pendingCheckRuns: CheckRunSummary[],
): string {
  if (status === "passed") return "All observed CI checks and statuses passed.";
  if (status === "failed") {
    const names = [...failedStatuses, ...failedCheckRuns].map((check) => check.name).join(", ");
    return `CI failed: ${names || "unknown check"}.`;
  }
  const pendingNames = [...pendingStatuses, ...pendingCheckRuns]
    .map((check) => check.name)
    .join(", ");
  return `CI is still pending: ${pendingNames || "checks not complete"}.`;
}

async function writeArtifact(task: TaskEnvelope, report: CiReport) {
  const artifactRoot =
    process.env.ANCHORAGE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "anchorage-agent-artifacts", task.run.id);
  await fs.mkdir(artifactRoot, { recursive: true });
  const artifactPath = path.join(artifactRoot, "ci-report.json");
  const content = `${JSON.stringify(report, null, 2)}\n`;
  await fs.writeFile(artifactPath, content, "utf8");
  return {
    artifactType: "ci.report",
    uri: `file://${artifactPath}`,
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(content),
  };
}

function readNumber(value: JsonValue | undefined): null | number {
  return typeof value === "number" ? value : null;
}

function readPositiveInteger(value: JsonValue | undefined): null | number {
  const number = typeof value === "number" ? value : null;
  return number && Number.isInteger(number) && number > 0 ? number : null;
}

function readEnvInteger(name: string): null | number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(task: TaskEnvelope, failureValue: CiWatcherFailure): number {
  emit(task, "agent.failed", "error", failureValue.message, {
    error: { code: failureValue.code, message: failureValue.message },
  });
  return failureValue.exitCode;
}

function failure(code: string, message: string, exitCode: number): CiWatcherFailure {
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

interface CiWatcherFailure extends AgentFailure {
  code: string;
  message: string;
}

interface CiWatchInput {
  owner: string;
  repo: string;
  prNumber: number;
  pollIntervalMs: number;
  maxPolls: number;
}

interface PrInfo {
  owner: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  headRef: string;
}

type StatusSummary = JsonObject & {
  name: string;
  state: string;
  description: string | null;
  targetUrl: string | null;
};

type CheckRunSummary = JsonObject & {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

type FailedCheckSummary = JsonObject & {
  name: string;
  conclusion: string | null;
  url: string | null;
};

type CiReport = ProtocolEvent["data"] & {
  status: CiStatus;
  prNumber: number;
  prUrl: string;
  owner: string;
  repo: string;
  headSha: string;
  headRef: string;
  observedAt: string;
  pollCount: number;
  summary: string;
  statuses: StatusSummary[];
  checkRuns: CheckRunSummary[];
  failedChecks: FailedCheckSummary[];
};

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
