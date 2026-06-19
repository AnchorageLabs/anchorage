#!/usr/bin/env node
import { spawn } from "node:child_process";
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

  if (task.value.task.type !== "gitlab.merge_request.open") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `gitlab-pr-opener only supports gitlab.merge_request.open, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "gitlab-pr-opener started", { agentVersion });

  const input = resolveInput(task.value);
  if (!input.ok) return fail(task.value, input);

  const token = process.env.GITLAB_TOKEN;
  if (!token) {
    const msg = "Set GITLAB_TOKEN to push and open a GitLab merge request.";
    emit(task.value, "agent.failed", "error", msg, {
      error: { code: "missing_gitlab_token", message: msg },
    });
    return ExitCode.MissingCapability;
  }

  const { workspacePath, project, baseBranch, change } = input.value;

  const pushed = await ensureBranchPushed(task.value, workspacePath, change, token, "oauth2");
  if (!pushed.ok) return fail(task.value, pushed.failure);

  const title = buildTitle(change);
  const description = buildDescription(change);
  const projectId = encodeURIComponent(project);

  emit(task.value, "tool.requested", "info", "Creating GitLab merge request", {
    tool: "gitlab.merge_requests.create",
    input: { project, source: change.branchName, target: baseBranch, title },
  });

  let mr: { iid: number; url: string; title: string };
  try {
    mr = await createMergeRequest(token, projectId, {
      source_branch: change.branchName,
      target_branch: baseBranch,
      title,
      description,
    });
  } catch (error) {
    // Idempotent re-open: an MR may already exist for this source branch.
    const existing = await findOpenMr(token, projectId, change.branchName).catch(() => null);
    if (!existing) {
      const message = error instanceof Error ? error.message : String(error);
      emit(task.value, "tool.result", "error", "GitLab MR creation failed", {
        tool: "gitlab.merge_requests.create",
        success: false,
        output: { error: { code: "gitlab_mr_create_failed", message } },
      });
      emit(task.value, "agent.failed", "error", "Failed to create merge request", {
        error: { code: "gitlab_mr_create_failed", message },
      });
      return ExitCode.ExternalDependencyFailure;
    }
    mr = existing;
  }

  emit(task.value, "tool.result", "info", `Merge request !${mr.iid} ready`, {
    tool: "gitlab.merge_requests.create",
    success: true,
    output: { prNumber: mr.iid, prUrl: mr.url, branchName: change.branchName },
  });

  const output: PrOpenedResult = {
    prNumber: mr.iid,
    prUrl: mr.url,
    branchName: change.branchName,
    baseBranch,
    title: mr.title || title,
    changedFiles: change.changedFiles,
  };
  emit(task.value, "agent.output", "info", "Merge request opened", output);
  const artifact = await writeResultArtifact(task.value, output);
  emit(task.value, "artifact.created", "info", "PR opened artifact created", artifact);
  emit(task.value, "agent.completed", "info", "gitlab-pr-opener completed successfully", {
    prNumber: mr.iid,
    prUrl: mr.url,
    branchName: change.branchName,
  });
  return ExitCode.Success;
}

async function createMergeRequest(
  token: string,
  projectId: string,
  body: Record<string, string>,
): Promise<{ iid: number; url: string; title: string }> {
  const response = await fetch(`${gitlabBase()}/api/v4/projects/${projectId}/merge_requests`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as JsonValue | null;
  if (!response.ok || !isObject(data)) {
    const message = isObject(data)
      ? (readString(data.message) ?? JSON.stringify(data))
      : `status ${response.status}`;
    throw new Error(`GitLab MR create failed: ${message}`);
  }
  return {
    iid: typeof data.iid === "number" ? data.iid : 0,
    url: readString(data.web_url) ?? "",
    title: readString(data.title) ?? "",
  };
}

async function findOpenMr(
  token: string,
  projectId: string,
  sourceBranch: string,
): Promise<{ iid: number; url: string; title: string } | null> {
  const response = await fetch(
    `${gitlabBase()}/api/v4/projects/${projectId}/merge_requests?state=opened&source_branch=${encodeURIComponent(sourceBranch)}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
  );
  const data = (await response.json().catch(() => null)) as JsonValue | null;
  if (!response.ok || !Array.isArray(data) || data.length === 0) return null;
  const mr = data[0];
  if (!isObject(mr)) return null;
  return {
    iid: typeof mr.iid === "number" ? mr.iid : 0,
    url: readString(mr.web_url) ?? "",
    title: readString(mr.title) ?? "",
  };
}

// ── Shared opener plumbing ────────────────────────────────────────────────────

interface CodeChange {
  branchName: string;
  changedFiles: string[];
  summary: string;
  issueNumber: null | number;
  pushed: boolean;
  commitSha: null | string;
  pushSkippedReason: null | string;
}

interface OpenerInput {
  workspacePath: string;
  project: string;
  baseBranch: string;
  change: CodeChange;
}

function resolveInput(task: TaskEnvelope): { ok: true; value: OpenerInput } | OpenerFailure {
  const workspacePath =
    typeof task.input.workspacePath === "string" && task.input.workspacePath.trim()
      ? path.resolve(process.cwd(), task.input.workspacePath)
      : null;
  if (!workspacePath) {
    return failure(
      "missing_workspace_path",
      "gitlab-pr-opener requires input.workspacePath pointing at the repository worktree.",
      ExitCode.InvalidInput,
    );
  }
  if (!task.repository) {
    return failure(
      "missing_repository",
      "gitlab-pr-opener requires repository.owner and repository.name in the task envelope.",
      ExitCode.InvalidInput,
    );
  }
  const change = resolveCodeChange(task);
  if (!change.ok) return change;
  return {
    ok: true,
    value: {
      workspacePath,
      project: `${task.repository.owner}/${task.repository.name}`,
      baseBranch: task.repository.defaultBranch ?? "main",
      change: change.value,
    },
  };
}

function resolveCodeChange(task: TaskEnvelope): { ok: true; value: CodeChange } | OpenerFailure {
  const direct = parseCodeChange(task.input.codeChangeResult);
  if (direct) return { ok: true, value: direct };

  const artifact = task.context?.priorArtifacts?.find(
    (a) => a.artifactType === "code.change.result",
  );
  if (!artifact?.uri.startsWith("file://")) {
    return failure(
      "missing_code_change_result",
      "gitlab-pr-opener requires input.codeChangeResult or a prior code.change.result artifact.",
      ExitCode.InvalidInput,
    );
  }
  try {
    const parsed = JSON.parse(readFileSync(new URL(artifact.uri), "utf8"));
    const change = parseCodeChange(parsed);
    if (change) return { ok: true, value: change };
  } catch (error) {
    return failure(
      "code_change_result_read_failed",
      `Could not read code.change.result artifact: ${(error as Error).message}`,
      ExitCode.InvalidInput,
    );
  }
  return failure(
    "invalid_code_change_result",
    "code.change.result must include branchName and changedFiles.",
    ExitCode.InvalidInput,
  );
}

function parseCodeChange(value: unknown): CodeChange | null {
  if (!isObject(value)) return null;
  if (typeof value.branchName !== "string" || !Array.isArray(value.changedFiles)) return null;
  return {
    branchName: value.branchName,
    changedFiles: value.changedFiles.filter(isString),
    summary: typeof value.summary === "string" ? value.summary : "",
    issueNumber: typeof value.issueNumber === "number" ? value.issueNumber : null,
    pushed: value.pushed === true,
    commitSha: typeof value.commitSha === "string" ? value.commitSha : null,
    pushSkippedReason: typeof value.pushSkippedReason === "string" ? value.pushSkippedReason : null,
  };
}

/** Push the branch to origin with token auth, unless the coder already did. */
async function ensureBranchPushed(
  task: TaskEnvelope,
  workspacePath: string,
  change: CodeChange,
  token: string,
  authUser: string,
): Promise<{ ok: true } | { ok: false; failure: OpenerFailure }> {
  if (change.pushed) return { ok: true };
  if (!change.commitSha) {
    const reason = change.pushSkippedReason
      ? ` coder pushSkippedReason=${change.pushSkippedReason}.`
      : "";
    return {
      ok: false,
      failure: failure(
        "branch_not_pushed",
        `code.change.result.pushed is not true and there is no coder commit to publish.${reason}`,
        ExitCode.ExternalDependencyFailure,
      ),
    };
  }
  const originResult = await runGit(workspacePath, ["remote", "get-url", "origin"]);
  const origin = originResult.stdout.trim();
  if (originResult.exitCode !== 0 || !origin) {
    return {
      ok: false,
      failure: failure(
        "no_origin_remote",
        "Workspace has no origin remote to publish from.",
        ExitCode.ExternalDependencyFailure,
      ),
    };
  }
  const pushTarget = authenticatedPushUrl(origin, token, authUser);
  emit(task, "tool.requested", "info", `Publishing branch ${change.branchName}`, {
    tool: "git.push",
    input: { branchName: change.branchName, remote: redactUrl(origin) },
  });
  const push = await runGit(workspacePath, [
    "push",
    pushTarget,
    `${change.branchName}:${change.branchName}`,
  ]);
  if (push.exitCode !== 0) {
    const message = redactToken(
      push.stderr.trim() || push.stdout.trim() || `git push failed (exit ${push.exitCode})`,
      token,
    );
    emit(task, "tool.result", "error", "Failed to publish branch", {
      tool: "git.push",
      success: false,
      output: { error: { code: "git_push_failed", message } },
    });
    return {
      ok: false,
      failure: failure("git_push_failed", message, ExitCode.ExternalDependencyFailure),
    };
  }
  emit(task, "tool.result", "info", "Branch published", {
    tool: "git.push",
    success: true,
    output: { branchName: change.branchName, remote: redactUrl(origin) },
  });
  return { ok: true };
}

function authenticatedPushUrl(origin: string, token: string, authUser: string): string {
  const withoutScheme = origin.replace(/^https:\/\/([^@/]*@)?/, "");
  return `https://${authUser}:${token}@${withoutScheme}`;
}

function buildTitle(change: CodeChange): string {
  const first = (change.summary.split("\n")[0] ?? "").trim();
  if (first.length > 0 && first.length <= 72) return first;
  if (change.issueNumber) return `Resolve issue #${change.issueNumber}`;
  return (
    change.branchName
      .replace(/^(feature|fix|chore|refactor|docs)\//i, "")
      .replaceAll(/[-_]/g, " ")
      .trim() || `Changes on ${change.branchName}`
  );
}

function buildDescription(change: CodeChange): string {
  const lines: string[] = ["## Summary", "", change.summary || "Automated change.", ""];
  lines.push("## Changed files", "");
  lines.push(
    change.changedFiles.length
      ? change.changedFiles.map((f) => `- \`${f}\``).join("\n")
      : "No files changed.",
  );
  lines.push("", "---", "*Opened by the anchorage gitlab-pr-opener agent.*");
  return lines.join("\n");
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdout.push(c));
    child.stderr.on("data", (c: Buffer) => stderr.push(c));
    child.on("error", (e) => resolve({ exitCode: 127, stdout: "", stderr: e.message }));
    child.on("close", (code) =>
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

function redactUrl(url: string): string {
  return url.replace(/\/\/[^@/]*@/, "//");
}

function redactToken(text: string, token: string): string {
  return text.split(token).join("***");
}

async function writeResultArtifact(task: TaskEnvelope, result: PrOpenedResult) {
  const artifactRoot =
    process.env.ANCHORAGE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "anchorage-agent-artifacts", task.run.id);
  await fs.mkdir(artifactRoot, { recursive: true });
  const artifactPath = path.join(artifactRoot, "pr-opened.json");
  const content = `${JSON.stringify(result, null, 2)}\n`;
  await fs.writeFile(artifactPath, content, "utf8");
  return {
    artifactType: "pr.opened",
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

function fail(task: TaskEnvelope, failureValue: OpenerFailure): number {
  emit(task, "agent.failed", "error", failureValue.message, {
    error: { code: failureValue.code, message: failureValue.message },
  });
  return failureValue.exitCode;
}

function failure(code: string, message: string, exitCode: number): OpenerFailure {
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

interface OpenerFailure extends AgentFailure {
  code: string;
  message: string;
}

type PrOpenedResult = ProtocolEvent["data"] & {
  prNumber: number;
  prUrl: string;
  branchName: string;
  baseBranch: string;
  title: string;
  changedFiles: string[];
};

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
