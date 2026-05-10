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

type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonObject | JsonValue[] | boolean | null | number | string;

const agentVersion = "0.1.0";
let eventSequence = 0;

async function main(): Promise<number> {
  const rawTask = await readStdin();
  const task = parseTask(rawTask);
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "code.change") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `coder only supports code.change, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "coder started", { agentVersion });

  const input = await resolveCoderInput(task.value);
  if (!input.ok) return fail(task.value, input);

  const auth = resolveBedrockConfig();
  if (!auth.ok) return fail(task.value, auth);

  const branchResult = await ensureBranch(
    task.value,
    input.value.workspacePath,
    input.value.plan.branchName,
  );
  if (!branchResult.ok) return fail(task.value, branchResult);

  const beforeStatus = await gitStatus(input.value.workspacePath);
  const workspaceContext = await collectWorkspaceContext(
    input.value.workspacePath,
    input.value.plan,
  );

  emit(task.value, "tool.requested", "info", "Requesting code changes from Bedrock", {
    tool: "bedrock.converse",
    input: {
      provider: "aws-bedrock",
      region: auth.value.region,
      model: auth.value.model,
      workspacePath: input.value.workspacePath,
      branchName: input.value.plan.branchName,
      contextFiles: workspaceContext.files.map((file) => file.path),
    },
  });

  const codeResult = await requestCodeChanges(auth.value, input.value.plan, workspaceContext);
  if (!codeResult.ok) {
    emit(task.value, "tool.result", "error", "Bedrock code generation failed", {
      tool: "bedrock.converse",
      success: false,
      error: { code: codeResult.code, message: codeResult.message },
    });
    return fail(task.value, codeResult);
  }

  const applyResult = await applyFileEdits(input.value.workspacePath, codeResult.value.fileEdits);
  if (!applyResult.ok) return fail(task.value, applyResult);

  const afterStatus = await gitStatus(input.value.workspacePath);
  const changedFiles = changedFilesFromStatus(afterStatus.stdout);

  emit(task.value, "tool.result", "info", "Bedrock code changes applied", {
    tool: "bedrock.converse",
    success: true,
    output: {
      region: auth.value.region,
      model: auth.value.model,
      stopReason: codeResult.value.stopReason,
      inputTokens: codeResult.value.inputTokens,
      outputTokens: codeResult.value.outputTokens,
      editedFiles: applyResult.value.editedFiles,
    },
  });

  const output: CodeChangeResult = {
    status: changedFiles.length > 0 ? "changed" : "no_changes",
    planId: input.value.plan.planId,
    branchName: input.value.plan.branchName,
    workspacePath: input.value.workspacePath,
    changedFiles,
    editedFiles: applyResult.value.editedFiles,
    beforeStatus: beforeStatus.stdout,
    afterStatus: afterStatus.stdout,
    model: auth.value.model,
    summary: codeResult.value.summary,
    commandsSuggested: codeResult.value.commandsSuggested,
  };

  emit(task.value, "agent.output", "info", "Code change result created", output);

  const artifact = await writeResultArtifact(task.value, output);
  emit(task.value, "artifact.created", "info", "Code change result artifact created", artifact);

  emit(task.value, "agent.completed", "info", "coder completed successfully", {
    planId: input.value.plan.planId,
    changedFiles,
    editedFiles: applyResult.value.editedFiles,
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
    for (const validationError of result.errors) console.error(JSON.stringify(validationError));
    return { ok: false, exitCode: ExitCode.InvalidInput };
  }

  return { ok: true, value: result.value };
}

async function resolveCoderInput(
  task: TaskEnvelope,
): Promise<{ ok: true; value: CoderInput } | CoderFailure> {
  const workspacePath = resolveWorkspacePath(task.input.workspacePath);
  if (!workspacePath) {
    return failure(
      "missing_workspace_path",
      "coder requires input.workspacePath pointing at the repository worktree.",
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

  const plan = await resolveImplementationPlan(task);
  if (!plan.ok) return plan;

  return { ok: true, value: { workspacePath, plan: plan.value } };
}

function resolveWorkspacePath(value: JsonValue | undefined): null | string {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return path.resolve(process.cwd(), value);
}

async function resolveImplementationPlan(
  task: TaskEnvelope,
): Promise<{ ok: true; value: ImplementationPlan } | CoderFailure> {
  const directPlan = parseImplementationPlan(task.input.plan);
  if (directPlan.ok) return directPlan;

  const artifact = task.context?.priorArtifacts?.find(
    (candidate) => candidate.artifactType === "implementation.plan",
  );
  if (!artifact) {
    return failure(
      "missing_implementation_plan",
      "coder requires input.plan or a prior implementation.plan artifact.",
      ExitCode.InvalidInput,
    );
  }

  if (!artifact.uri.startsWith("file://")) {
    return failure(
      "unsupported_artifact_uri",
      "coder currently supports local file:// implementation.plan artifacts only.",
      ExitCode.InvalidInput,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(new URL(artifact.uri), "utf8"));
  } catch (error) {
    return failure(
      "implementation_plan_read_failed",
      `Could not read implementation.plan artifact: ${(error as Error).message}`,
      ExitCode.InvalidInput,
    );
  }

  const artifactPlan = parseImplementationPlan(parsed);
  if (!artifactPlan.ok) {
    return failure(
      "invalid_implementation_plan",
      "implementation.plan must include planId, goal, branchName, implementationSteps, acceptanceCriteria, verificationCommands, and handoff.",
      ExitCode.InvalidInput,
    );
  }

  return artifactPlan;
}

function parseImplementationPlan(
  value: unknown,
): { ok: true; value: ImplementationPlan } | { ok: false } {
  if (!isObject(value)) return { ok: false };
  if (typeof value.planId !== "string") return { ok: false };
  if (typeof value.goal !== "string") return { ok: false };
  if (typeof value.branchName !== "string") return { ok: false };
  if (!Array.isArray(value.implementationSteps)) return { ok: false };
  if (!Array.isArray(value.acceptanceCriteria)) return { ok: false };
  if (!Array.isArray(value.verificationCommands)) return { ok: false };
  if (!isObject(value.handoff)) return { ok: false };

  return {
    ok: true,
    value: {
      planId: value.planId,
      goal: value.goal,
      branchName: value.branchName,
      summary: typeof value.summary === "string" ? value.summary : "",
      implementationSteps: value.implementationSteps.filter(isString),
      acceptanceCriteria: value.acceptanceCriteria.filter(isString),
      likelyFiles: Array.isArray(value.likelyFiles) ? value.likelyFiles.filter(isString) : [],
      verificationCommands: value.verificationCommands.filter(isString),
      risks: Array.isArray(value.risks) ? value.risks.filter(isString) : [],
      handoff: {
        nextAgent: typeof value.handoff.nextAgent === "string" ? value.handoff.nextAgent : "coder",
        taskType:
          typeof value.handoff.taskType === "string" ? value.handoff.taskType : "code.change",
        instructions:
          typeof value.handoff.instructions === "string" ? value.handoff.instructions : "",
      },
    },
  };
}

function resolveBedrockConfig(): { ok: true; value: BedrockConfig } | CoderFailure {
  if (!hasBedrockAuth()) {
    return failure(
      "missing_llm_api_key",
      "Set AWS_BEARER_TOKEN_BEDROCK or standard AWS credentials so coder can call Bedrock.",
      ExitCode.MissingCapability,
    );
  }

  return {
    ok: true,
    value: {
      region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
      model: process.env.ANCHORAGE_CODER_MODEL ?? "us.anthropic.claude-opus-4-7",
    },
  };
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

async function collectWorkspaceContext(
  workspacePath: string,
  plan: ImplementationPlan,
): Promise<WorkspaceContext> {
  const maxFiles = Number(process.env.ANCHORAGE_CODER_MAX_CONTEXT_FILES ?? 12);
  const maxBytes = Number(process.env.ANCHORAGE_CODER_MAX_FILE_BYTES ?? 60000);
  const files: WorkspaceFile[] = [];
  const candidates = unique(
    plan.likelyFiles.filter((filePath) => filePath !== "TBD by coder after repository inspection"),
  ).slice(0, maxFiles);

  for (const candidate of candidates) {
    const safePath = safeWorkspacePath(workspacePath, candidate);
    if (!safePath) continue;
    const stat = await fs.stat(safePath.absolutePath).catch(() => null);
    if (!stat?.isFile() || stat.size > maxBytes) continue;
    const content = await fs.readFile(safePath.absolutePath, "utf8").catch(() => null);
    if (content === null) continue;
    files.push({ path: safePath.relativePath, content });
  }

  return { files };
}

async function requestCodeChanges(
  config: BedrockConfig,
  plan: ImplementationPlan,
  workspaceContext: WorkspaceContext,
): Promise<{ ok: true; value: BedrockCodeResult } | CoderFailure> {
  const maxTokens = Number(process.env.ANCHORAGE_CODER_MAX_TOKENS ?? 120000);
  const maxAttempts = Number(process.env.ANCHORAGE_CODER_MAX_ATTEMPTS ?? 2);
  const client = new BedrockRuntimeClient({ region: config.region });
  const userPrompt = coderUserPrompt(plan, workspaceContext);

  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: unknown;
    try {
      response = await client.send(
        new ConverseCommand({
          modelId: config.model,
          system: [{ text: coderSystemPrompt() }],
          messages: [{ role: "user", content: [{ text: userPrompt }] }],
          inferenceConfig: { maxTokens, temperature: 0.1 },
        }),
      );
    } catch (error) {
      return failure(
        "llm_request_failed",
        error instanceof Error ? error.message : String(error),
        ExitCode.ExternalDependencyFailure,
      );
    }

    const parsedResponse = parseBedrockResponse(response);
    if (!parsedResponse.ok) {
      return failure(
        "invalid_llm_response",
        parsedResponse.message,
        ExitCode.ExternalDependencyFailure,
      );
    }

    // If Bedrock stopped because the output hit the token limit the JSON will be
    // truncated. Fail fast with a clear message rather than a confusing parse error.
    if (parsedResponse.stopReason === "max_tokens") {
      return failure(
        "llm_output_truncated",
        `Bedrock stopped at max_tokens (${maxTokens}). The feature is too large for one coder call. ` +
          `Set ANCHORAGE_CODER_MAX_TOKENS to a higher value or break the issue into smaller tasks.`,
        ExitCode.ExternalDependencyFailure,
      );
    }

    const parsedJson = parseCodeJson(parsedResponse.text);
    if (!parsedJson.ok) {
      lastError = parsedJson.message;
      if (attempt < maxAttempts) continue; // retry
      return failure("invalid_llm_code_json", lastError, ExitCode.ExternalDependencyFailure);
    }

    const normalized = normalizeCodeResult(parsedJson.value, parsedResponse);
    if (!normalized.ok) {
      return failure(
        "invalid_llm_code_result",
        normalized.message,
        ExitCode.ExternalDependencyFailure,
      );
    }

    return { ok: true, value: normalized.value };
  }

  return failure("invalid_llm_code_json", lastError, ExitCode.ExternalDependencyFailure);
}

function coderSystemPrompt(): string {
  return `You are Anchorage coder, a code-writing agent in a CLI-first multi-agent software workflow.
Return only strict JSON. Do not wrap it in markdown.
You receive an implementation plan and selected repository files.
Produce the smallest safe workspace change that satisfies the plan.
Do not include secrets. Do not commit, push, open PRs, or run commands.
If necessary context is missing, edit only files you can confidently update and explain residual risk.
The JSON shape must be:
{
  "summary": string,
  "fileEdits": [{"path": string, "content": string}],
  "commandsSuggested": string[],
  "risks": string[]
}`;
}

function coderUserPrompt(plan: ImplementationPlan, workspaceContext: WorkspaceContext): string {
  return JSON.stringify(
    {
      task: "Apply this implementation plan by returning full-file edits.",
      plan,
      workspaceContext,
      constraints: [
        "Return only JSON matching the requested shape.",
        "Each fileEdits entry must contain a repository-relative path and the full final file content.",
        "Only edit files that are necessary for the plan.",
        "If you create a new file, include its full content.",
        "Do not include markdown fences around JSON or file contents.",
      ],
    },
    null,
    2,
  );
}

function parseBedrockResponse(
  value: unknown,
):
  | { ok: true; text: string; stopReason: null | string; inputTokens: number; outputTokens: number }
  | { ok: false; message: string } {
  if (!isObject(value)) return { ok: false, message: "Bedrock response was not an object." };
  const output = isObject(value.output) ? value.output : {};
  const message = isObject(output.message) ? output.message : {};
  if (!Array.isArray(message.content)) {
    return { ok: false, message: "Bedrock response did not include output.message.content[]." };
  }

  const text = message.content
    .map((block) => (isObject(block) ? block.text : null))
    .filter(isString)
    .join("\n")
    .trim();
  if (!text) return { ok: false, message: "Bedrock response did not include text content." };

  const usage = isObject(value.usage) ? value.usage : {};
  return {
    ok: true,
    text,
    stopReason: typeof value.stopReason === "string" ? value.stopReason : null,
    inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : 0,
    outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : 0,
  };
}

function parseCodeJson(
  value: string,
): { ok: true; value: JsonObject } | { ok: false; message: string } {
  const json = extractJsonObject(value);
  if (!json) return { ok: false, message: "LLM response did not contain a JSON object." };
  try {
    const parsed = JSON.parse(json);
    if (!isObject(parsed)) return { ok: false, message: "LLM code JSON was not an object." };
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, message: `LLM code JSON was invalid: ${(error as Error).message}` };
  }
}

function extractJsonObject(value: string): null | string {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return value.slice(start, end + 1);
}

function normalizeCodeResult(
  value: JsonObject,
  response: { stopReason: null | string; inputTokens: number; outputTokens: number },
): { ok: true; value: BedrockCodeResult } | { ok: false; message: string } {
  if (!Array.isArray(value.fileEdits)) {
    return { ok: false, message: "LLM code JSON must include fileEdits[]." };
  }

  const fileEdits = value.fileEdits
    .map((entry): null | FileEdit => {
      if (!isObject(entry)) return null;
      if (typeof entry.path !== "string" || typeof entry.content !== "string") return null;
      return { path: entry.path, content: entry.content };
    })
    .filter(isFileEdit);

  return {
    ok: true,
    value: {
      summary: typeof value.summary === "string" ? value.summary : "",
      fileEdits,
      commandsSuggested: Array.isArray(value.commandsSuggested)
        ? value.commandsSuggested.filter(isString)
        : [],
      risks: Array.isArray(value.risks) ? value.risks.filter(isString) : [],
      stopReason: response.stopReason,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    },
  };
}

function isFileEdit(value: null | FileEdit): value is FileEdit {
  return value !== null;
}

async function applyFileEdits(
  workspacePath: string,
  fileEdits: FileEdit[],
): Promise<{ ok: true; value: { editedFiles: string[] } } | CoderFailure> {
  const editedFiles: string[] = [];
  for (const edit of fileEdits) {
    const safePath = safeWorkspacePath(workspacePath, edit.path);
    if (!safePath) {
      return failure(
        "unsafe_file_edit_path",
        `Refusing to edit path outside workspace: ${edit.path}`,
        ExitCode.InvalidInput,
      );
    }
    await fs.mkdir(path.dirname(safePath.absolutePath), { recursive: true });
    await fs.writeFile(safePath.absolutePath, edit.content, "utf8");
    editedFiles.push(safePath.relativePath);
  }
  return { ok: true, value: { editedFiles } };
}

function safeWorkspacePath(
  workspacePath: string,
  requestedPath: string,
): null | { absolutePath: string; relativePath: string } {
  const normalized = requestedPath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) return null;
  const absolutePath = path.resolve(workspacePath, normalized);
  const relativePath = path.relative(workspacePath, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
  return { absolutePath, relativePath };
}

async function ensureBranch(
  task: TaskEnvelope,
  workspacePath: string,
  branchName: string,
): Promise<{ ok: true } | CoderFailure> {
  emit(task, "tool.requested", "info", `Switching to branch ${branchName}`, {
    tool: "git.switch",
    input: { branchName, workspacePath },
  });

  const createResult = await runGit(workspacePath, ["switch", "-c", branchName]);
  if (createResult.exitCode === 0) {
    emit(task, "tool.result", "info", `Created and switched to branch ${branchName}`, {
      tool: "git.switch",
      success: true,
      output: { created: true, branchName },
    });
    return { ok: true };
  }

  const switchResult = await runGit(workspacePath, ["switch", branchName]);
  if (switchResult.exitCode === 0) {
    emit(task, "tool.result", "info", `Switched to existing branch ${branchName}`, {
      tool: "git.switch",
      success: true,
      output: { created: false, branchName },
    });
    return { ok: true };
  }

  const message =
    switchResult.stderr ||
    switchResult.stdout ||
    `git switch failed with exit ${switchResult.exitCode}`;
  emit(task, "tool.result", "error", `Failed to switch to branch ${branchName}`, {
    tool: "git.switch",
    success: false,
    error: { code: "branch_checkout_failed", message },
  });
  return failure("branch_checkout_failed", message, ExitCode.ExternalDependencyFailure);
}

async function runGit(workspacePath: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: workspacePath, stdio: ["ignore", "pipe", "pipe"] });
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

async function gitStatus(workspacePath: string): Promise<CommandResult> {
  return runGit(workspacePath, ["status", "--short"]);
}

function changedFilesFromStatus(status: string): string[] {
  return status
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(isString);
}

async function writeResultArtifact(task: TaskEnvelope, result: CodeChangeResult) {
  const artifactRoot =
    process.env.ANCHORAGE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "anchorage-agent-artifacts", task.run.id);
  await fs.mkdir(artifactRoot, { recursive: true });

  const artifactPath = path.join(artifactRoot, "code-change-result.json");
  const content = `${JSON.stringify(result, null, 2)}\n`;
  await fs.writeFile(artifactPath, content, "utf8");

  return {
    artifactType: "code.change.result",
    uri: `file://${artifactPath}`,
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(content),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function fail(task: TaskEnvelope, failureValue: CoderFailure): number {
  emit(task, "agent.failed", "error", failureValue.message, {
    error: { code: failureValue.code, message: failureValue.message },
  });
  return failureValue.exitCode;
}

function failure(code: string, message: string, exitCode: number): CoderFailure {
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

interface CoderFailure extends AgentFailure {
  code: string;
  message: string;
}

interface CoderInput {
  workspacePath: string;
  plan: ImplementationPlan;
}

interface BedrockConfig {
  region: string;
  model: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface WorkspaceContext {
  files: WorkspaceFile[];
}

interface WorkspaceFile {
  path: string;
  content: string;
}

interface FileEdit {
  path: string;
  content: string;
}

interface BedrockCodeResult {
  summary: string;
  fileEdits: FileEdit[];
  commandsSuggested: string[];
  risks: string[];
  stopReason: null | string;
  inputTokens: number;
  outputTokens: number;
}

type ImplementationPlan = JsonObject & {
  planId: string;
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

type CodeChangeResult = ProtocolEvent["data"] & {
  status: string;
  planId: string;
  branchName: string;
  workspacePath: string;
  changedFiles: string[];
  editedFiles: string[];
  beforeStatus: string;
  afterStatus: string;
  model: string;
  summary: string;
  commandsSuggested: string[];
};

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
