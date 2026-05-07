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
import { Octokit } from "@octokit/rest";

type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonObject | JsonValue[] | boolean | null | number | string;

const agentVersion = "0.1.0";
let eventSequence = 0;

async function main(): Promise<number> {
  const rawTask = await readStdin();
  const task = parseTask(rawTask);
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "pr.open") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `pr-opener only supports pr.open, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "pr-opener started", { agentVersion });

  const input = await resolvePrOpenerInput(task.value);
  if (!input.ok) return fail(task.value, input);

  const { workspacePath, codeChangeResult, owner, name: repoName, baseBranch } = input.value;
  const { branchName, changedFiles, summary } = codeChangeResult;

  // git add -A
  emit(task.value, "tool.requested", "info", "Staging all workspace changes", {
    tool: "git.add",
    input: { cwd: workspacePath, args: ["-A"] },
  });

  const addResult = await runGit(workspacePath, ["add", "-A"]);

  emit(task.value, "tool.result", "info", "git add completed", {
    tool: "git.add",
    success: addResult.exitCode === 0,
    output: { exitCode: addResult.exitCode, stderr: addResult.stderr },
  });

  // git commit
  const commitMessage = summary || "Apply code changes";
  emit(task.value, "tool.requested", "info", "Committing changes", {
    tool: "git.commit",
    input: { cwd: workspacePath, message: commitMessage },
  });

  const commitResult = await runGit(workspacePath, ["commit", "-m", commitMessage]);

  const commitSuccess = commitResult.exitCode === 0;
  const nothingToCommit = !commitSuccess && commitResult.stdout.includes("nothing to commit");

  emit(task.value, "tool.result", "info", "git commit completed", {
    tool: "git.commit",
    success: commitSuccess || nothingToCommit,
    output: {
      exitCode: commitResult.exitCode,
      stdout: commitResult.stdout.slice(0, 500),
      stderr: commitResult.stderr.slice(0, 500),
      nothingToCommit,
    },
  });

  // git push -u origin <branchName>
  emit(task.value, "tool.requested", "info", `Pushing branch ${branchName}`, {
    tool: "git.push",
    input: { cwd: workspacePath, remote: "origin", branch: branchName },
  });

  const pushResult = await runGit(workspacePath, ["push", "-u", "origin", branchName]);

  if (pushResult.exitCode !== 0) {
    emit(task.value, "tool.result", "error", "git push failed", {
      tool: "git.push",
      success: false,
      error: { code: "git_push_failed", message: pushResult.stderr || pushResult.stdout },
    });
    emit(task.value, "agent.failed", "error", "Failed to push branch", {
      error: {
        code: "git_push_failed",
        message: pushResult.stderr || pushResult.stdout,
      },
    });
    return ExitCode.ExternalDependencyFailure;
  }

  emit(task.value, "tool.result", "info", "git push completed", {
    tool: "git.push",
    success: true,
    output: {
      exitCode: pushResult.exitCode,
      stderr: pushResult.stderr.slice(0, 500),
    },
  });

  // Create PR via Octokit
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) {
    const msg = "Set GH_TOKEN or GITHUB_TOKEN to create a GitHub PR.";
    emit(task.value, "agent.failed", "error", msg, {
      error: { code: "missing_github_token", message: msg },
    });
    return ExitCode.MissingCapability;
  }

  const prTitle = summary || `PR for ${branchName}`;
  const prBody = buildPrBody(codeChangeResult);

  emit(task.value, "tool.requested", "info", "Creating GitHub PR", {
    tool: "github.pulls.create",
    input: {
      owner,
      repo: repoName,
      head: branchName,
      base: baseBranch,
      title: prTitle,
    },
  });

  let prNumber: number;
  let prUrl: string;

  try {
    const octokit = new Octokit({ auth: token });
    const response = await octokit.pulls.create({
      owner,
      repo: repoName,
      head: branchName,
      base: baseBranch,
      title: prTitle,
      body: prBody,
    });
    prNumber = response.data.number;
    prUrl = response.data.html_url;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(task.value, "tool.result", "error", "GitHub PR creation failed", {
      tool: "github.pulls.create",
      success: false,
      error: { code: "github_pr_create_failed", message },
    });
    emit(task.value, "agent.failed", "error", "Failed to create PR", {
      error: { code: "github_pr_create_failed", message },
    });
    return ExitCode.ExternalDependencyFailure;
  }

  emit(task.value, "tool.result", "info", `PR #${prNumber} created`, {
    tool: "github.pulls.create",
    success: true,
    output: { prNumber, prUrl, branchName, baseBranch },
  });

  const output: PrOpenedResult = {
    prNumber,
    prUrl,
    branchName,
    baseBranch,
    title: prTitle,
    changedFiles,
  };

  emit(task.value, "agent.output", "info", "PR opened", output);

  const artifact = await writeResultArtifact(task.value, output);
  emit(task.value, "artifact.created", "info", "PR opened artifact created", artifact);

  emit(task.value, "agent.completed", "info", "pr-opener completed successfully", {
    prNumber,
    prUrl,
    branchName,
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

async function resolvePrOpenerInput(
  task: TaskEnvelope,
): Promise<{ ok: true; value: PrOpenerInput } | PrOpenerFailure> {
  const workspacePath = resolveWorkspacePath(task.input.workspacePath);
  if (!workspacePath) {
    return failure(
      "missing_workspace_path",
      "pr-opener requires input.workspacePath pointing at the repository worktree.",
      ExitCode.InvalidInput,
    );
  }

  const workspaceStat = await fs.stat(workspacePath).catch(() => null);
  if (!workspaceStat?.isDirectory()) {
    return failure(
      "invalid_workspace_path",
      "input.workspacePath must be a directory.",
      ExitCode.InvalidInput,
    );
  }

  if (!task.repository) {
    return failure(
      "missing_repository",
      "pr-opener requires repository.owner and repository.name in the task envelope.",
      ExitCode.InvalidInput,
    );
  }

  const owner = task.repository.owner;
  const repoName = task.repository.name;
  const baseBranch = task.repository.defaultBranch ?? "main";

  const codeChangeResult = resolveCodeChangeResult(task);
  if (!codeChangeResult.ok) return codeChangeResult;

  return {
    ok: true,
    value: {
      workspacePath,
      owner,
      name: repoName,
      baseBranch,
      codeChangeResult: codeChangeResult.value,
    },
  };
}

function resolveWorkspacePath(value: JsonValue | undefined): null | string {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return path.resolve(process.cwd(), value);
}

function resolveCodeChangeResult(
  task: TaskEnvelope,
): { ok: true; value: CodeChangeInput } | PrOpenerFailure {
  const directResult = parseCodeChangeResult(task.input.codeChangeResult);
  if (directResult.ok) return directResult;

  const artifact = task.context?.priorArtifacts?.find(
    (candidate) => candidate.artifactType === "code.change.result",
  );
  if (!artifact) {
    return failure(
      "missing_code_change_result",
      "pr-opener requires input.codeChangeResult or a prior code.change.result artifact.",
      ExitCode.InvalidInput,
    );
  }

  if (!artifact.uri.startsWith("file://")) {
    return failure(
      "unsupported_artifact_uri",
      "pr-opener currently supports local file:// code.change.result artifacts only.",
      ExitCode.InvalidInput,
    );
  }

  let parsed: unknown;
  try {
    const raw = readFileSync(new URL(artifact.uri), "utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    return failure(
      "code_change_result_read_failed",
      `Could not read code.change.result artifact: ${(error as Error).message}`,
      ExitCode.InvalidInput,
    );
  }

  const artifactResult = parseCodeChangeResult(parsed);
  if (!artifactResult.ok) {
    return failure(
      "invalid_code_change_result",
      "code.change.result must include branchName, changedFiles, and summary.",
      ExitCode.InvalidInput,
    );
  }

  return artifactResult;
}

function parseCodeChangeResult(
  value: unknown,
): { ok: true; value: CodeChangeInput } | { ok: false } {
  if (!isObject(value)) return { ok: false };
  if (typeof value.branchName !== "string") return { ok: false };
  if (!Array.isArray(value.changedFiles)) return { ok: false };

  return {
    ok: true,
    value: {
      branchName: value.branchName,
      changedFiles: value.changedFiles.filter(isString),
      summary: typeof value.summary === "string" ? value.summary : "",
      planId: typeof value.planId === "string" ? value.planId : null,
    },
  };
}

function buildPrBody(codeChange: CodeChangeInput): string {
  const lines: string[] = [];
  lines.push("## Summary");
  lines.push("");
  if (codeChange.summary) {
    lines.push(codeChange.summary);
  } else {
    lines.push("Automated PR opened by pr-opener agent.");
  }
  lines.push("");

  if (codeChange.changedFiles.length > 0) {
    lines.push("## Changed Files");
    lines.push("");
    for (const file of codeChange.changedFiles) {
      lines.push(`- \`${file}\``);
    }
    lines.push("");
  }

  if (codeChange.planId) {
    lines.push(`**Plan ID:** \`${codeChange.planId}\``);
    lines.push("");
  }

  lines.push("---");
  lines.push("*Opened by [pr-opener](https://github.com/AnchorageLabs/anchorage) agent.*");
  return lines.join("\n");
}

async function runGit(cwd: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => resolve({ exitCode: 127, stdout: "", stderr: error.message }));
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
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

function fail(task: TaskEnvelope, failureValue: PrOpenerFailure): number {
  emit(task, "agent.failed", "error", failureValue.message, {
    error: { code: failureValue.code, message: failureValue.message },
  });
  return failureValue.exitCode;
}

function failure(code: string, message: string, exitCode: number): PrOpenerFailure {
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

interface AgentFailure {
  ok: false;
  exitCode: number;
}

interface PrOpenerFailure extends AgentFailure {
  code: string;
  message: string;
}

interface PrOpenerInput {
  workspacePath: string;
  owner: string;
  name: string;
  baseBranch: string;
  codeChangeResult: CodeChangeInput;
}

interface CodeChangeInput {
  branchName: string;
  changedFiles: string[];
  summary: string;
  planId: null | string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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
