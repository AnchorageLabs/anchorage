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

const agentVersion = "0.1.0";
let eventSequence = 0;

// Upper bound on exploration turns. This is a safety stop against runaway cost /
// the step's own duration ceiling — NOT a failure condition: when the budget is
// reached the agent forces a finalize instead of giving up (see exploreAndDraft).
// Opening the issue is the most important step in the pipeline, so it must always
// translate the user's instruction into an issue.
const MAX_STEPS = 16;
const MAX_OBSERVATION_CHARS = 4000;
const MAX_DIR_ENTRIES = 200;
const LLM_MAX_TOKENS = 4000;

async function main(): Promise<number> {
  const task = parseTask(readFileSync(0, "utf8"));
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "issue.open") {
    return failTask(
      task.value,
      "unsupported_task_type",
      `issue-opener only supports issue.open, got ${task.value.task.type}`,
      ExitCode.UnsupportedTaskType,
    );
  }

  emit(task.value, "agent.started", "info", "issue-opener started", { agentVersion });

  const input = resolveInput(task.value);
  if (!input.ok) return failTask(task.value, input.code, input.message, input.exitCode);

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    return failTask(
      task.value,
      "missing_github_token",
      "Set GH_TOKEN or GITHUB_TOKEN to create a GitHub issue.",
      ExitCode.MissingCapability,
    );
  }

  // ── 1. Explore the repository and draft the issue ──────────────────────────
  const draft = await exploreAndDraft(task.value, input.value);
  if (!draft.ok) return failTask(task.value, draft.code, draft.message, draft.exitCode);

  // ── 2. Create the issue on GitHub ──────────────────────────────────────────
  const { owner, name: repoName } = input.value;
  emit(task.value, "tool.requested", "info", `Creating issue in ${owner}/${repoName}`, {
    tool: "github.issues.create",
    input: { owner, repo: repoName, title: draft.value.title, labels: draft.value.labels },
  });

  let issueNumber: number;
  let issueUrl: string;
  let author: null | string;
  try {
    const octokit = new Octokit({ auth: token });
    const response = await octokit.issues.create({
      owner,
      repo: repoName,
      title: draft.value.title,
      body: draft.value.body,
      ...(draft.value.labels.length > 0 ? { labels: draft.value.labels } : {}),
    });
    issueNumber = response.data.number;
    issueUrl = response.data.html_url;
    author = response.data.user?.login ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(task.value, "tool.result", "error", "GitHub issue creation failed", {
      tool: "github.issues.create",
      success: false,
      error: { code: "github_issue_create_failed", message },
    });
    return failTask(
      task.value,
      "github_issue_create_failed",
      message,
      ExitCode.ExternalDependencyFailure,
    );
  }

  emit(task.value, "tool.result", "info", `Issue #${issueNumber} created`, {
    tool: "github.issues.create",
    success: true,
    output: { issueNumber, issueUrl, title: draft.value.title },
  });

  // ── 3. Emit artifacts: issue.opened (record) + issue.summary (for the planner) ─
  const opened: IssueOpened = { issueNumber, issueUrl, title: draft.value.title };
  emit(task.value, "agent.output", "info", "Issue opened", opened);
  const openedArtifact = await writeArtifact(
    task.value,
    "issue.opened",
    "issue-opened.json",
    opened,
  );
  emit(task.value, "artifact.created", "info", "Issue opened artifact created", openedArtifact);

  const summary: IssueSummary = {
    issueNumber,
    title: draft.value.title,
    repository: `${owner}/${repoName}`,
    state: "open",
    labels: draft.value.labels,
    body: draft.value.body,
    url: issueUrl,
    author,
  };
  const summaryArtifact = await writeArtifact(
    task.value,
    "issue.summary",
    "issue-summary.json",
    summary,
  );
  emit(task.value, "artifact.created", "info", "Issue summary artifact created", summaryArtifact);

  emit(task.value, "agent.completed", "info", "issue-opener completed successfully", {
    issueNumber,
    issueUrl,
    title: draft.value.title,
  });

  return ExitCode.Success;
}

// ── Agentic exploration loop ──────────────────────────────────────────────────

interface IssueDraft {
  title: string;
  body: string;
  labels: string[];
}

async function exploreAndDraft(
  task: TaskEnvelope,
  input: ResolvedInput,
): Promise<{ ok: true; value: IssueDraft } | AgentFailureDetail> {
  const config = resolveLlmConfig({
    role: "issue-opener",
    anthropicModel: "claude-sonnet-4-6",
    bedrockModel: "us.anthropic.claude-sonnet-4-6",
    openaiModel: "gpt-4.1",
  });
  if (!config.ok) {
    // The issue is the most important step in the pipeline — never abort. With no
    // LLM we can still translate the instruction faithfully into a minimal issue.
    emit(
      task,
      "agent.progress",
      "warn",
      "LLM unavailable; drafting the issue from the instruction",
      {
        reason: config.message,
      },
    );
    return { ok: true, value: fallbackDraft(input.instruction) };
  }

  emit(task, "agent.progress", "info", "Exploring repository to draft the issue", {
    ...llmEventInput(config.value),
    instruction: input.instruction,
  });

  // Single-shot completion API: keep `system` fixed and grow the ReAct transcript
  // in `user`. Each turn the model emits one JSON action; we run it and append the
  // observation, until it finalizes or we hit the step cap.
  const system = buildSystemPrompt();
  let transcript = `Instruction from the user:\n${input.instruction}\n\nYou have up to ${MAX_STEPS} exploration steps before you must finalize. Explore enough to ground the issue, then finalize. Respond with your first JSON action.`;

  for (let step = 0; step < MAX_STEPS; step++) {
    const completion = await requestLlmCompletion(config.value, {
      system,
      user: transcript,
      maxTokens: LLM_MAX_TOKENS,
    });
    if (!completion.ok) {
      // Don't lose the user's request to a transient model error: finalize with
      // whatever we have, falling back to a draft built straight from the instruction.
      emit(
        task,
        "agent.progress",
        "warn",
        "LLM request failed; finalizing the issue with what we have",
        {
          reason: completion.message,
        },
      );
      return {
        ok: true,
        value: await finalizeOrFallback(task, config.value, system, transcript, input.instruction),
      };
    }

    const action = parseAction(completion.value.text);
    if (!action) {
      transcript += `\n\nASSISTANT:\n${truncate(completion.value.text, 500)}\n\nOBSERVATION:\nYour reply was not a single valid JSON action. Reply with exactly one JSON object and nothing else.`;
      continue;
    }

    if (action.action === "finalize") {
      const draft = validateFinalize(action);
      if (!draft.ok) {
        transcript += `\n\nASSISTANT:\n${JSON.stringify(action)}\n\nOBSERVATION:\n${draft.message}`;
        continue;
      }
      emit(task, "agent.progress", "info", "Issue draft finalized", {
        title: draft.value.title,
        labels: draft.value.labels,
        steps: step + 1,
      });
      return { ok: true, value: draft.value };
    }

    emit(task, "tool.requested", "info", `explore: ${action.action}`, {
      tool: `workspace.${action.action}`,
      input: {
        ...(action.path ? { path: action.path } : {}),
        ...(action.query ? { query: action.query } : {}),
      },
    });
    const observation = await runExploreAction(input.workspacePath, action);
    emit(task, "tool.result", "info", `explore: ${action.action} done`, {
      tool: `workspace.${action.action}`,
      success: true,
      output: { bytes: observation.length },
    });

    transcript += `\n\nASSISTANT:\n${JSON.stringify(action)}\n\nOBSERVATION:\n${observation}`;
  }

  // Budget reached without a finalize. Rather than fail (and produce no issue),
  // force a final draft — the issue-opener must always yield an actionable issue.
  emit(
    task,
    "agent.progress",
    "warn",
    `Reached the ${MAX_STEPS}-step exploration limit; finalizing the issue now`,
    {
      steps: MAX_STEPS,
    },
  );
  return {
    ok: true,
    value: await finalizeOrFallback(task, config.value, system, transcript, input.instruction),
  };
}

/**
 * Last-resort finalization. Makes one mandatory finalize turn using the full
 * transcript; if the model still won't return a valid draft, synthesizes one
 * directly from the instruction so the issue is never lost.
 */
async function finalizeOrFallback(
  task: TaskEnvelope,
  config: Parameters<typeof requestLlmCompletion>[0],
  system: string,
  transcript: string,
  instruction: string,
): Promise<IssueDraft> {
  const forced = `${transcript}\n\nOBSERVATION:\nNo more exploration is allowed. Respond NOW with exactly one {"action":"finalize",...} JSON object that turns the user's instruction into a detailed issue using what you have learned. Do not request any more exploration.`;
  const completion = await requestLlmCompletion(config, {
    system,
    user: forced,
    maxTokens: LLM_MAX_TOKENS,
  });
  if (completion.ok) {
    const action = parseAction(completion.value.text);
    if (action?.action === "finalize") {
      const draft = validateFinalize(action);
      if (draft.ok) {
        emit(task, "agent.progress", "info", "Issue draft finalized", {
          title: draft.value.title,
          labels: draft.value.labels,
          forced: true,
        });
        return draft.value;
      }
    }
  }
  emit(task, "agent.progress", "warn", "Drafting the issue directly from the instruction", {});
  return fallbackDraft(instruction);
}

/**
 * A faithful, deterministic issue built straight from the user's instruction.
 * Used only when the model cannot produce a valid draft — guarantees the
 * instruction is always captured as an actionable issue.
 */
function fallbackDraft(instruction: string): IssueDraft {
  const firstLine =
    instruction
      .split("\n")
      .map((line) => line.trim().replace(/^#+\s*/, ""))
      .find((line) => line.length > 0) ?? "Automated change request";
  const title = firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
  const body = [
    "## Problem / Goal",
    "",
    "Created directly from the user's instruction (full repository exploration was not completed).",
    "",
    "## Instruction (verbatim)",
    "",
    instruction,
    "",
    "## Acceptance criteria",
    "",
    "- [ ] The change described in the instruction above is implemented.",
    "- [ ] The project builds and existing tests pass.",
  ].join("\n");
  return { title, body, labels: [] };
}

function buildSystemPrompt(): string {
  return [
    "You are issue-opener, an agent that turns a natural-language instruction into a detailed, actionable GitHub issue for an autonomous coding pipeline.",
    "You explore a checked-out repository to understand the actual implementation before writing the issue.",
    "",
    "On every turn reply with EXACTLY ONE JSON object and nothing else (no prose, no markdown fences). Valid actions:",
    '  {"action":"list_dir","path":"<relative dir, e.g. \\".\\" or \\"src\\">"}',
    '  {"action":"read_file","path":"<relative file path>"}',
    '  {"action":"search","query":"<substring or symbol to grep for>"}',
    '  {"action":"finalize","title":"<concise issue title>","body":"<full markdown body>","labels":["optional","labels"]}',
    "",
    "Paths are relative to the repository root. Explore enough to ground the issue in real files, then finalize.",
    "The issue body must be detailed and self-contained for a downstream coding agent. Include these sections:",
    "  - **Problem / Goal**: what the user wants and why.",
    "  - **Context**: the relevant existing code, with concrete file paths and symbols you found.",
    "  - **Proposed approach**: a clear implementation direction.",
    "  - **Acceptance criteria**: a checklist of verifiable outcomes.",
    "  - **Out of scope**: what not to change.",
    "Be specific to THIS repository — reference the files and patterns you actually observed.",
  ].join("\n");
}

interface ExploreAction {
  action: "list_dir" | "read_file" | "search" | "finalize";
  path?: string;
  query?: string;
  title?: string;
  body?: string;
  labels?: unknown;
}

function parseAction(text: string): ExploreAction | null {
  let raw = text.trim();
  // Strip a leading/trailing markdown code fence if the model added one.
  const fence = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence && fence[1] !== undefined) raw = fence[1].trim();
  // Fall back to the outermost braces if there is surrounding prose.
  if (!raw.startsWith("{")) {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first === -1 || last <= first) return null;
    raw = raw.slice(first, last + 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(parsed) || typeof parsed.action !== "string") return null;
  const action = parsed.action;
  if (
    action !== "list_dir" &&
    action !== "read_file" &&
    action !== "search" &&
    action !== "finalize"
  ) {
    return null;
  }
  return parsed as unknown as ExploreAction;
}

function validateFinalize(
  action: ExploreAction,
): { ok: true; value: IssueDraft } | { ok: false; message: string } {
  const title = typeof action.title === "string" ? action.title.trim() : "";
  const body = typeof action.body === "string" ? action.body.trim() : "";
  if (!title) return { ok: false, message: "finalize requires a non-empty 'title'." };
  if (!body) return { ok: false, message: "finalize requires a non-empty 'body'." };
  const labels = Array.isArray(action.labels)
    ? action.labels.filter((l): l is string => typeof l === "string" && l.length > 0)
    : [];
  return { ok: true, value: { title, body, labels } };
}

// ── Read-only workspace operations (path-guarded) ─────────────────────────────

async function runExploreAction(workspacePath: string, action: ExploreAction): Promise<string> {
  switch (action.action) {
    case "list_dir":
      return listDir(workspacePath, action.path ?? ".");
    case "read_file":
      return readFile(workspacePath, action.path ?? "");
    case "search":
      return search(workspacePath, action.query ?? "");
    default:
      return "Unknown action.";
  }
}

/**
 * Resolve a model-supplied relative path against the workspace root and reject
 * anything that escapes it. The loop runs model output against the filesystem,
 * so this guard is the trust boundary.
 */
function safeResolve(workspacePath: string, relative: string): string | null {
  const root = path.resolve(workspacePath);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

async function listDir(workspacePath: string, relative: string): Promise<string> {
  const dir = safeResolve(workspacePath, relative);
  if (!dir) return `Refused: '${relative}' is outside the repository.`;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    return `Could not list '${relative}': ${(error as Error).message}`;
  }
  const lines = entries
    .filter((e) => e.name !== ".git" && e.name !== "node_modules")
    .slice(0, MAX_DIR_ENTRIES)
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  const header = `Contents of ${relative}/ (${lines.length} entries${entries.length > MAX_DIR_ENTRIES ? ", truncated" : ""}):`;
  return truncate(`${header}\n${lines.join("\n")}`, MAX_OBSERVATION_CHARS);
}

async function readFile(workspacePath: string, relative: string): Promise<string> {
  const file = safeResolve(workspacePath, relative);
  if (!file) return `Refused: '${relative}' is outside the repository.`;
  try {
    const content = await fs.readFile(file, "utf8");
    return truncate(`File ${relative}:\n${content}`, MAX_OBSERVATION_CHARS);
  } catch (error) {
    return `Could not read '${relative}': ${(error as Error).message}`;
  }
}

async function search(workspacePath: string, query: string): Promise<string> {
  if (!query.trim()) return "Empty search query.";
  // `git grep` is fast and respects the repo's tracked files; fixed-string (-F)
  // search avoids the model needing to escape regex metacharacters.
  const result = await runGit(workspacePath, [
    "grep",
    "-n",
    "-I",
    "--fixed-strings",
    "--max-count=5",
    query,
  ]);
  if (result.exitCode !== 0 && !result.stdout.trim()) {
    return `No matches for "${query}".`;
  }
  return truncate(`Matches for "${query}":\n${result.stdout}`, MAX_OBSERVATION_CHARS);
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runGit(workspacePath: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: workspacePath, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => resolve({ exitCode: 127, stdout: "", stderr: error.message }));
    child.on("close", (code) =>
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

// ── Input / artifacts / helpers ───────────────────────────────────────────────

interface ResolvedInput {
  instruction: string;
  workspacePath: string;
  owner: string;
  name: string;
}

function resolveInput(task: TaskEnvelope): { ok: true; value: ResolvedInput } | AgentFailureDetail {
  const instruction =
    typeof task.input.instruction === "string" ? task.input.instruction.trim() : "";
  if (!instruction) {
    return detail(
      "missing_instruction",
      "input.instruction must be a non-empty string.",
      ExitCode.InvalidInput,
    );
  }
  const workspacePath =
    typeof task.input.workspacePath === "string" ? task.input.workspacePath.trim() : "";
  if (!workspacePath) {
    return detail(
      "missing_workspace",
      "input.workspacePath must be provided so the agent can scan the code.",
      ExitCode.InvalidInput,
    );
  }
  if (!task.repository || !task.repository.owner || !task.repository.name) {
    return detail(
      "missing_repository",
      "task.repository.owner and task.repository.name are required.",
      ExitCode.InvalidInput,
    );
  }
  return {
    ok: true,
    value: { instruction, workspacePath, owner: task.repository.owner, name: task.repository.name },
  };
}

async function writeArtifact(
  task: TaskEnvelope,
  artifactType: string,
  fileName: string,
  payload: unknown,
) {
  const artifactRoot =
    process.env.ANCHORAGE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "anchorage-agent-artifacts", task.run.id);
  await fs.mkdir(artifactRoot, { recursive: true });
  const artifactPath = path.join(artifactRoot, fileName);
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  await fs.writeFile(artifactPath, content, "utf8");
  return {
    artifactType,
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

function failTask(task: TaskEnvelope, code: string, message: string, exitCode: number): number {
  emit(task, "agent.failed", "error", message, { error: { code, message } });
  return exitCode;
}

function detail(code: string, message: string, exitCode: number): AgentFailureDetail {
  return { ok: false, code, message, exitCode };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…(truncated)`;
}

function isObject(value: unknown): value is Record<string, unknown> {
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

interface AgentFailureDetail extends AgentFailure {
  code: string;
  message: string;
}

interface IssueOpened {
  [key: string]: number | string;
  issueNumber: number;
  issueUrl: string;
  title: string;
}

type IssueSummary = ProtocolEvent["data"] & {
  issueNumber: number;
  title: string;
  repository: null | string;
  state: string;
  labels: string[];
  body: string;
  url: null | string;
  author: null | string;
};

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
