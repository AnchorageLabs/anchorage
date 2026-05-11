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
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { Octokit } from "@octokit/rest";

type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonObject | JsonValue[] | boolean | null | number | string;

const agentVersion = "0.1.0";
let eventSequence = 0;

async function main(): Promise<number> {
  const rawTask = await readStdin();
  const task = parseTask(rawTask);
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "pull_request.open") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `pr-opener only supports pull_request.open, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "pr-opener started", { agentVersion });

  const input = await resolvePrOpenerInput(task.value);
  if (!input.ok) return fail(task.value, input);

  const { workspacePath, codeChangeResult, owner, name: repoName, baseBranch } = input.value;
  const { branchName, changedFiles } = codeChangeResult;
  const stagePaths = validateStagePaths(changedFiles);
  if (!stagePaths.ok) return fail(task.value, stagePaths);

  // Verify there are no uncommitted conflicting changes outside the staged files.
  const statusBeforeAdd = await runGit(workspacePath, ["status", "--porcelain"]);
  const unrelatedDirty = statusBeforeAdd.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => {
      const filePath = l.slice(3).trim();
      return !stagePaths.value.some((sp) => filePath.startsWith(sp) || sp.startsWith(filePath));
    });

  if (unrelatedDirty.length > 0) {
    emit(
      task.value,
      "agent.output",
      "warn" as ProtocolEvent["level"],
      "Workspace has untracked changes outside changedFiles",
      {
        warning: {
          code: "workspace_dirty",
          message: `${unrelatedDirty.length} file(s) outside changedFiles are dirty. They will not be staged.`,
          files: unrelatedDirty.slice(0, 10),
        },
      },
    );
  }

  emit(task.value, "tool.requested", "info", "Staging code-change files", {
    tool: "git.add",
    input: { cwd: workspacePath, args: ["--", ...stagePaths.value] },
  });

  const addResult = await runGit(workspacePath, ["add", "--", ...stagePaths.value]);
  emit(task.value, "tool.result", "info", "git add completed", {
    tool: "git.add",
    success: addResult.exitCode === 0,
    output: { exitCode: addResult.exitCode, stderr: addResult.stderr },
  });

  const commitMessage = codeChangeResult.summary || "Apply code changes";
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

  emit(task.value, "tool.requested", "info", `Pushing branch ${branchName}`, {
    tool: "git.push",
    input: { cwd: workspacePath, remote: "origin", branch: branchName },
  });

  const pushResult = await pushWithRebase(task.value, workspacePath, branchName);
  if (!pushResult.ok) return ExitCode.ExternalDependencyFailure;

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    const msg = "Set GH_TOKEN or GITHUB_TOKEN to create a GitHub PR.";
    emit(task.value, "agent.failed", "error", msg, {
      error: { code: "missing_github_token", message: msg },
    });
    return ExitCode.MissingCapability;
  }

  const prContent = await generatePrContent(task.value, input.value);

  emit(task.value, "tool.requested", "info", "Creating GitHub PR", {
    tool: "github.pulls.create",
    input: { owner, repo: repoName, head: branchName, base: baseBranch, title: prContent.title },
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
      title: prContent.title,
      body: prContent.body,
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
    title: prContent.title,
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

// ── PR content generation via LLM ────────────────────────────────────────────

async function generatePrContent(
  task: TaskEnvelope,
  input: PrOpenerInput,
): Promise<{ title: string; body: string }> {
  if (!hasBedrockAuth()) {
    return fallbackPrContent(input);
  }

  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  const model =
    process.env.ANCHORAGE_PR_OPENER_MODEL ??
    process.env.ANCHORAGE_PLANNER_MODEL ??
    "us.anthropic.claude-sonnet-4-6";

  emit(task, "tool.requested", "info", "Generating PR title and body via LLM", {
    tool: "bedrock.converse",
    input: { provider: "aws-bedrock", region, model },
  });

  let response: unknown;
  try {
    const client = new BedrockRuntimeClient({ region });
    response = await client.send(
      new ConverseCommand({
        modelId: model,
        system: [{ text: prContentSystemPrompt() }],
        messages: [{ role: "user", content: [{ text: prContentUserPrompt(input) }] }],
        inferenceConfig: { maxTokens: 1200, temperature: 0.2 },
      }),
    );
  } catch {
    emit(task, "tool.result", "info", "LLM PR content failed, using fallback", {
      tool: "bedrock.converse",
      success: false,
    });
    return fallbackPrContent(input);
  }

  const text = extractBedrockText(response);
  if (!text) return fallbackPrContent(input);

  const parsed = parsePrContentJson(text);
  if (!parsed) return fallbackPrContent(input);

  emit(task, "tool.result", "info", "LLM PR content generated", {
    tool: "bedrock.converse",
    success: true,
    output: { titleLength: parsed.title.length },
  });

  return assemblePrContent(parsed, input.codeChangeResult);
}

function prContentSystemPrompt(): string {
  return `You are a senior engineer writing a GitHub pull request for a teammate to review.
Return only strict JSON. Do not wrap it in markdown.
The JSON shape must be:
{
  "title": string,
  "summary": string,
  "why": string,
  "what": string,
  "how": string,
  "notes": string
}
Rules:
- title: imperative mood, max 60 chars, no trailing period. Example: "Add secret manager token support to restore"
- summary: one sentence describing the change, max 120 chars
- why: one concise paragraph — the problem or gap this change addresses
- what: one concise paragraph — what changed (components, files, behaviour)
- how: one concise paragraph — the implementation approach and key decisions
- notes: risks, caveats, follow-ups worth flagging. Empty string if none.`;
}

function prContentUserPrompt(input: PrOpenerInput): string {
  const { codeChangeResult, plan } = input;
  return JSON.stringify(
    {
      task: "Write a pull request title and body for this code change.",
      issueNumber: codeChangeResult.issueNumber,
      issueTitle: readString(plan, "issue", "title"),
      issueBody: readString(plan, "issue", "body"),
      goal: typeof plan?.goal === "string" ? plan.goal : null,
      implementationSummary: codeChangeResult.summary,
      changedFiles: codeChangeResult.changedFiles,
      risks: Array.isArray(plan?.risks) ? plan.risks : [],
    },
    null,
    2,
  );
}

function readString(obj: JsonObject | null, ...keys: string[]): string | null {
  let current: JsonValue | undefined = obj as JsonValue;
  for (const key of keys) {
    if (!isObject(current)) return null;
    current = current[key];
  }
  return typeof current === "string" ? current : null;
}

function parsePrContentJson(text: string): PrContentRaw | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.title !== "string" || typeof parsed.why !== "string") return null;
    return parsed as PrContentRaw;
  } catch {
    return null;
  }
}

function assemblePrContent(
  content: PrContentRaw,
  codeChange: CodeChangeInput,
): { title: string; body: string } {
  const lines: string[] = [];

  lines.push("## Summary");
  lines.push("");
  lines.push(content.summary?.trim() || content.why?.trim() || "See below.");
  lines.push("");

  lines.push("## Why");
  lines.push("");
  lines.push(content.why?.trim() || "Resolves the issue.");
  lines.push("");

  lines.push("## What");
  lines.push("");
  lines.push(content.what?.trim() || changedFilesList(codeChange.changedFiles));
  lines.push("");

  lines.push("## How");
  lines.push("");
  lines.push(content.how?.trim() || codeChange.summary || "See changed files.");
  lines.push("");

  if (content.notes?.trim()) {
    lines.push("## Notes");
    lines.push("");
    lines.push(content.notes.trim());
    lines.push("");
  }

  if (codeChange.issueNumber) {
    lines.push(`Closes #${codeChange.issueNumber}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("*Opened by [pr-opener](https://github.com/AnchorageLabs/anchorage) agent.*");

  return { title: content.title.trim(), body: lines.join("\n") };
}

function fallbackPrContent(input: PrOpenerInput): { title: string; body: string } {
  const { codeChangeResult } = input;
  const title = buildFallbackTitle(codeChangeResult);
  const lines: string[] = [];

  lines.push("## Summary");
  lines.push("");
  lines.push(codeChangeResult.summary || "Automated PR opened by pr-opener agent.");
  lines.push("");

  lines.push("## What");
  lines.push("");
  lines.push(changedFilesList(codeChangeResult.changedFiles));
  lines.push("");

  if (codeChangeResult.issueNumber) {
    lines.push(`Closes #${codeChangeResult.issueNumber}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("*Opened by [pr-opener](https://github.com/AnchorageLabs/anchorage) agent.*");

  return { title, body: lines.join("\n") };
}

function buildFallbackTitle(codeChange: CodeChangeInput): string {
  if (codeChange.summary) {
    const first = (codeChange.summary.split("\n")[0] ?? "").trim();
    if (first.length > 0 && first.length <= 60) return first;
  }
  if (codeChange.issueNumber) return `Fix issue #${codeChange.issueNumber}`;
  return (
    codeChange.branchName
      .replace(/^(feature|fix|chore|refactor|docs)\//i, "")
      .replaceAll(/[-_]/g, " ")
      .trim() || `Code changes on ${codeChange.branchName}`
  );
}

function changedFilesList(files: string[]): string {
  if (files.length === 0) return "No files changed.";
  return files.map((f) => `- \`${f}\``).join("\n");
}

function hasBedrockAuth(): boolean {
  return Boolean(
    process.env.AWS_BEARER_TOKEN_BEDROCK ||
      process.env.AWS_ACCESS_KEY_ID ||
      process.env.AWS_PROFILE ||
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
  );
}

function extractBedrockText(value: unknown): null | string {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const output = v.output as Record<string, unknown> | undefined;
  const message = output?.message as Record<string, unknown> | undefined;
  if (!Array.isArray(message?.content)) return null;
  const text = (message.content as unknown[])
    .map((b) => (typeof b === "object" && b !== null ? (b as Record<string, unknown>).text : null))
    .filter((t): t is string => typeof t === "string")
    .join("\n")
    .trim();
  return text || null;
}

// ── Input resolution ──────────────────────────────────────────────────────────

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
    for (const validationError of result.errors) console.error(JSON.stringify(validationError));
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

  const codeChangeResult = resolveCodeChangeResult(task);
  if (!codeChangeResult.ok) return codeChangeResult;

  const plan = await readPlanArtifact(task);

  return {
    ok: true,
    value: {
      workspacePath,
      owner: task.repository.owner,
      name: task.repository.name,
      baseBranch: task.repository.defaultBranch ?? "main",
      codeChangeResult: codeChangeResult.value,
      plan,
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
      issueNumber: extractIssueNumber(value),
      issueUrl: extractIssueUrl(value),
    },
  };
}

async function readPlanArtifact(task: TaskEnvelope): Promise<JsonObject | null> {
  const artifact = task.context?.priorArtifacts?.find(
    (a) => a.artifactType === "implementation.plan",
  );
  if (!artifact?.uri.startsWith("file://")) return null;
  try {
    const raw = await fs.readFile(new URL(artifact.uri), "utf8");
    const parsed = JSON.parse(raw);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function validateStagePaths(
  changedFiles: string[],
): { ok: true; value: string[] } | PrOpenerFailure {
  const stagePaths = unique(changedFiles.map((file) => file.trim()).filter(isString));
  if (stagePaths.length === 0) {
    return failure(
      "no_changed_files",
      "code.change.result changedFiles must include at least one file to stage.",
      ExitCode.InvalidInput,
    );
  }
  for (const file of stagePaths) {
    if (isUnsafeStagePath(file)) {
      return failure(
        "unsafe_changed_file_path",
        `code.change.result changedFiles contains an unsafe path: ${file}`,
        ExitCode.InvalidInput,
      );
    }
  }
  return { ok: true, value: stagePaths };
}

function isUnsafeStagePath(file: string): boolean {
  if (file.includes("\0") || path.isAbsolute(file)) return true;
  const normalized = path.posix.normalize(file.replaceAll("\\", "/"));
  return (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized === ".git" ||
    normalized.startsWith(".git/")
  );
}

function extractIssueNumber(value: JsonObject): null | number {
  if (typeof value.issueNumber === "number" && Number.isInteger(value.issueNumber))
    return value.issueNumber;
  if (isObject(value.issue) && typeof value.issue.issueNumber === "number")
    return value.issue.issueNumber;
  if (typeof value.planId === "string") {
    const match = value.planId.match(/_(\d+)$/);
    if (match?.[1]) {
      const n = Number(match[1]);
      if (Number.isInteger(n) && n > 0) return n;
    }
  }
  return null;
}

function extractIssueUrl(value: JsonObject): null | string {
  if (typeof value.issueUrl === "string" && value.issueUrl.startsWith("http"))
    return value.issueUrl;
  if (isObject(value.issue) && typeof value.issue.url === "string") return value.issue.url;
  return null;
}

// ── Git / artifact helpers ────────────────────────────────────────────────────

async function pushWithRebase(
  task: TaskEnvelope,
  workspacePath: string,
  branchName: string,
): Promise<{ ok: boolean }> {
  const first = await runGit(workspacePath, ["push", "-u", "origin", branchName]);
  if (first.exitCode === 0) {
    emit(task, "tool.result", "info", "git push completed", {
      tool: "git.push",
      success: true,
      output: { exitCode: first.exitCode, stderr: first.stderr.slice(0, 500) },
    });
    return { ok: true };
  }

  const rejectedAsNonFastForward = /\[rejected\][^\n]*\((fetch first|non-fast-forward)\)/.test(
    first.stderr,
  );
  if (!rejectedAsNonFastForward) {
    emit(task, "tool.result", "error", "git push failed", {
      tool: "git.push",
      success: false,
      error: { code: "git_push_failed", message: first.stderr || first.stdout },
    });
    emit(task, "agent.failed", "error", "Failed to push branch", {
      error: { code: "git_push_failed", message: first.stderr || first.stdout },
    });
    return { ok: false };
  }

  emit(task, "tool.result", "warn", "git push rejected; rebasing onto remote and retrying", {
    tool: "git.push",
    success: false,
    output: { stderr: first.stderr.slice(0, 500) },
  });

  const fetchResult = await runGit(workspacePath, ["fetch", "origin", branchName]);
  if (fetchResult.exitCode !== 0) {
    const msg = fetchResult.stderr || fetchResult.stdout;
    emit(task, "agent.failed", "error", "git fetch failed during push recovery", {
      error: { code: "git_fetch_failed", message: msg },
    });
    return { ok: false };
  }

  const rebaseResult = await runGit(workspacePath, ["rebase", `origin/${branchName}`]);
  if (rebaseResult.exitCode !== 0) {
    await runGit(workspacePath, ["rebase", "--abort"]);
    const msg = rebaseResult.stderr || rebaseResult.stdout;
    emit(task, "agent.failed", "error", "git rebase onto origin failed; manual resolution needed", {
      error: { code: "git_rebase_conflict", message: msg },
    });
    return { ok: false };
  }

  const retry = await runGit(workspacePath, ["push", "-u", "origin", branchName]);
  if (retry.exitCode !== 0) {
    const msg = retry.stderr || retry.stdout;
    emit(task, "agent.failed", "error", "git push failed after rebase", {
      error: { code: "git_push_failed_after_rebase", message: msg },
    });
    return { ok: false };
  }

  emit(task, "tool.result", "info", "git push completed after rebase", {
    tool: "git.push",
    success: true,
    output: { exitCode: retry.exitCode, stderr: retry.stderr.slice(0, 500) },
  });
  return { ok: true };
}

async function runGit(cwd: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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

// ── Util ──────────────────────────────────────────────────────────────────────

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

function unique(values: string[]): string[] {
  return [...new Set(values)];
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
  plan: JsonObject | null;
}

interface CodeChangeInput {
  branchName: string;
  changedFiles: string[];
  summary: string;
  planId: null | string;
  issueNumber: null | number;
  issueUrl: null | string;
}

interface PrContentRaw {
  title: string;
  summary: string;
  why: string;
  what: string;
  how: string;
  notes: string;
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
