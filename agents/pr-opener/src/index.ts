#!/usr/bin/env node
import { spawn } from "node:child_process";
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

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    const msg = "Set GH_TOKEN or GITHUB_TOKEN to create a GitHub PR.";
    emit(task.value, "agent.failed", "error", msg, {
      error: { code: "missing_github_token", message: msg },
    });
    return ExitCode.MissingCapability;
  }

  const octokit = new Octokit({ auth: token });
  let noChangeExistingPr: { number: number; html_url: string; title: string } | null = null;

  if (!codeChangeResult.pushed && isNoChangeWithoutCommit(codeChangeResult)) {
    noChangeExistingPr = await findOpenPrForBranch(octokit, owner, repoName, branchName);
    if (noChangeExistingPr) {
      emit(task.value, "tool.result", "warn", "No new commit; reusing existing PR", {
        tool: "github.pulls.list",
        success: true,
        output: {
          prNumber: noChangeExistingPr.number,
          prUrl: noChangeExistingPr.html_url,
          branchName,
          pushSkippedReason: codeChangeResult.pushSkippedReason,
        },
      });
    }
  }

  if (!codeChangeResult.pushed && !noChangeExistingPr) {
    const publish = await publishBranch(task.value, workspacePath, codeChangeResult, token);
    if (!publish.ok) return fail(task.value, publish.failure);
  }

  if (noChangeExistingPr) {
    const output: PrOpenedResult = {
      prNumber: noChangeExistingPr.number,
      prUrl: noChangeExistingPr.html_url,
      branchName,
      baseBranch,
      title: noChangeExistingPr.title,
      changedFiles,
    };

    emit(task.value, "agent.output", "warn", "Existing PR reused after no-op code change", output);
    const artifact = await writeResultArtifact(task.value, output);
    emit(task.value, "artifact.created", "info", "PR opened artifact created", artifact);
    emit(task.value, "agent.completed", "warn", "pr-opener completed with existing PR", {
      prNumber: noChangeExistingPr.number,
      prUrl: noChangeExistingPr.html_url,
      branchName,
      pushSkippedReason: codeChangeResult.pushSkippedReason,
    });

    return ExitCode.Success;
  }

  const prContent = await generatePrContent(task.value, input.value);

  emit(task.value, "tool.requested", "info", "Creating GitHub PR", {
    tool: "github.pulls.create",
    input: { owner, repo: repoName, head: branchName, base: baseBranch, title: prContent.title },
  });

  let prNumber: number;
  let prUrl: string;
  let reused = false;

  try {
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
    // Idempotent re-open: a feedback loop (reviewer/tester → coder) re-runs
    // pr-opener after the PR already exists, which GitHub rejects with 422. In
    // that case reuse the open PR for this branch — the coder's new commits are
    // already pushed to it, so the PR reflects the revised change. Any other
    // failure is fatal as before.
    const existing = await findOpenPrForBranch(octokit, owner, repoName, branchName);
    if (!existing) {
      const message = error instanceof Error ? error.message : String(error);
      emit(task.value, "tool.result", "error", "GitHub PR creation failed", {
        tool: "github.pulls.create",
        success: false,
        output: { error: { code: "github_pr_create_failed", message } },
      });
      emit(task.value, "agent.failed", "error", "Failed to create PR", {
        error: { code: "github_pr_create_failed", message },
      });
      return ExitCode.ExternalDependencyFailure;
    }
    prNumber = existing.number;
    prUrl = existing.html_url;
    reused = true;
  }

  emit(task.value, "tool.result", "info", `PR #${prNumber} ${reused ? "reused" : "created"}`, {
    tool: "github.pulls.create",
    success: true,
    output: { prNumber, prUrl, branchName, baseBranch, reused },
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
  // Use the shared LLM adapter so the title/body respect the configured provider
  // (ANCHORAGE_LLM_PROVIDER: anthropic/openai/bedrock/...). The previous
  // Bedrock-only path silently fell back to a generic "Fix issue #N" title for
  // every non-Bedrock provider.
  const config = resolveLlmConfig({
    role: "pr-opener",
    anthropicModel: "claude-sonnet-4-6",
    bedrockModel: "us.anthropic.claude-sonnet-4-6",
    openaiModel: "gpt-4.1",
  });
  if (!config.ok) {
    // No LLM configured at all — deterministic fallback title/body.
    return fallbackPrContent(input);
  }

  emit(task, "tool.requested", "info", "Generating PR title and body via LLM", {
    tool: config.value.tool,
    input: llmEventInput(config.value, { issueNumber: input.codeChangeResult.issueNumber }),
  });

  const response = await requestLlmCompletion(config.value, {
    system: prContentSystemPrompt(),
    user: prContentUserPrompt(input),
    temperature: 0.2,
  });
  if (!response.ok) {
    emit(task, "tool.result", "warn", "LLM PR content failed, using fallback", {
      tool: config.value.tool,
      success: false,
      output: { error: response.message, fallback: true },
    });
    return fallbackPrContent(input);
  }

  const parsed = parsePrContentJson(response.value.text);
  if (!parsed) return fallbackPrContent(input);

  emit(task, "tool.result", "info", "LLM PR content generated", {
    tool: config.value.tool,
    success: true,
    output: { ...llmEventInput(config.value), titleLength: parsed.title.length },
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

async function findOpenPrForBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchName: string,
): Promise<{ number: number; html_url: string; title: string } | null> {
  try {
    const response = await octokit.pulls.list({
      owner,
      repo,
      head: `${owner}:${branchName}`,
      state: "open",
      per_page: 1,
    });
    const pr = response.data[0];
    return pr ? { number: pr.number, html_url: pr.html_url, title: pr.title } : null;
  } catch {
    return null;
  }
}

function isNoChangeWithoutCommit(codeChangeResult: CodeChangeInput): boolean {
  return !codeChangeResult.commitSha && codeChangeResult.pushSkippedReason === "no_changes";
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
      pushed: value.pushed === true,
      commitSha: typeof value.commitSha === "string" ? value.commitSha : null,
      pushSkippedReason:
        typeof value.pushSkippedReason === "string" ? value.pushSkippedReason : null,
    },
  };
}

async function publishBranch(
  task: TaskEnvelope,
  workspacePath: string,
  codeChangeResult: CodeChangeInput,
  token: string,
): Promise<{ ok: true } | { ok: false; failure: PrOpenerFailure }> {
  if (!codeChangeResult.commitSha) {
    const reason = codeChangeResult.pushSkippedReason
      ? ` coder pushSkippedReason=${codeChangeResult.pushSkippedReason}.`
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
        "code.change.result.pushed is not true and the workspace has no origin remote to publish from.",
        ExitCode.ExternalDependencyFailure,
      ),
    };
  }

  const pushTarget = authenticatedPushUrl(origin, token);
  if (!pushTarget) {
    return {
      ok: false,
      failure: failure(
        "unsupported_remote_or_missing_token",
        `code.change.result.pushed is not true and origin cannot be pushed with token auth: ${redactUrl(origin)}`,
        ExitCode.ExternalDependencyFailure,
      ),
    };
  }

  emit(task, "tool.requested", "info", `Publishing branch ${codeChangeResult.branchName}`, {
    tool: "git.push",
    input: { branchName: codeChangeResult.branchName, remote: redactUrl(origin) },
  });

  const push = await runGit(workspacePath, [
    "push",
    pushTarget,
    `${codeChangeResult.branchName}:${codeChangeResult.branchName}`,
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
    output: { branchName: codeChangeResult.branchName, remote: redactUrl(origin) },
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

function authenticatedPushUrl(origin: string, token: string): null | string {
  const httpsOrigin = githubHttpsOrigin(origin);
  if (!httpsOrigin) return null;
  const withoutCreds = httpsOrigin.replace(/^https:\/\/([^@/]*@)?/, "");
  return `https://x-access-token:${token}@${withoutCreds}`;
}

function githubHttpsOrigin(origin: string): null | string {
  if (origin.startsWith("https://")) return origin;

  const sshMatch = /^git@github\.com:([^/]+)\/(.+)$/.exec(origin);
  if (!sshMatch) return null;
  const [, owner, repo] = sshMatch;
  return `https://github.com/${owner}/${repo}`;
}

function redactUrl(url: string): string {
  return url.replace(/\/\/[^@/]*@/, "//");
}

function redactToken(text: string, token: string): string {
  return text.split(token).join("***");
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

// ── Artifact helpers ──────────────────────────────────────────────────────────

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
  // Delivery flags recorded by the coder (issue #39): whether it committed and
  // pushed the branch. The pr-opener requires `pushed` to open a PR.
  pushed: boolean;
  commitSha: null | string;
  pushSkippedReason: null | string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface PrContentRaw {
  title: string;
  summary: string;
  why: string;
  what: string;
  how: string;
  notes: string;
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
