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
  if (!input.ok) {
    emit(task.value, "agent.failed", "error", input.message, {
      error: { code: input.code, message: input.message },
    });
    return input.exitCode;
  }

  const command = resolveCoderCommand();
  if (!command.ok) {
    emit(task.value, "agent.failed", "error", command.message, {
      error: { code: command.code, message: command.message },
    });
    return command.exitCode;
  }

  const prompt = buildCoderPrompt(input.value.plan);
  const beforeStatus = await gitStatus(input.value.workspacePath);

  emit(task.value, "tool.requested", "info", "Running coding CLI", {
    tool: "coder.cli",
    input: {
      command: command.value.command,
      args: redactPromptArg(command.value.args),
      workspacePath: input.value.workspacePath,
      branchName: input.value.plan.branchName,
    },
  });

  const result = await runCommand(command.value, prompt, input.value.workspacePath);
  const afterStatus = await gitStatus(input.value.workspacePath);
  const changedFiles = changedFilesFromStatus(afterStatus.stdout);

  if (result.exitCode !== 0) {
    emit(task.value, "tool.result", "error", "Coding CLI failed", {
      tool: "coder.cli",
      success: false,
      error: {
        code: "coder_cli_failed",
        message: truncate(result.stderr || result.stdout || `exit ${result.exitCode}`),
      },
    });
    emit(task.value, "agent.failed", "error", "Coding CLI failed", {
      error: {
        code: "coder_cli_failed",
        message: `Coding CLI exited with ${result.exitCode}.`,
      },
    });
    return ExitCode.ExternalDependencyFailure;
  }

  emit(task.value, "tool.result", "info", "Coding CLI completed", {
    tool: "coder.cli",
    success: true,
    output: {
      exitCode: result.exitCode,
      changedFiles,
      stdoutBytes: Buffer.byteLength(result.stdout),
      stderrBytes: Buffer.byteLength(result.stderr),
    },
  });

  const output: CodeChangeResult = {
    status: "changed",
    planId: input.value.plan.planId,
    branchName: input.value.plan.branchName,
    workspacePath: input.value.workspacePath,
    changedFiles,
    beforeStatus: beforeStatus.stdout,
    afterStatus: afterStatus.stdout,
    command: command.value.command,
    args: redactPromptArg(command.value.args),
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
  };

  emit(task.value, "agent.output", "info", "Code change result created", output);

  const artifact = await writeResultArtifact(task.value, output);
  emit(task.value, "artifact.created", "info", "Code change result artifact created", artifact);

  emit(task.value, "agent.completed", "info", "coder completed successfully", {
    planId: input.value.plan.planId,
    changedFiles,
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

  let rawArtifact: string;
  try {
    rawArtifact = await fs.readFile(new URL(artifact.uri), "utf8");
  } catch (error) {
    return failure(
      "implementation_plan_read_failed",
      `Could not read implementation.plan artifact: ${(error as Error).message}`,
      ExitCode.InvalidInput,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArtifact);
  } catch (error) {
    return failure(
      "invalid_implementation_plan_json",
      `implementation.plan artifact is not valid JSON: ${(error as Error).message}`,
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

function resolveCoderCommand(): { ok: true; value: CoderCommand } | CoderFailure {
  const command = process.env.ANCHORAGE_CODER_COMMAND ?? "claude";
  const args = parseArgsJson(process.env.ANCHORAGE_CODER_ARGS_JSON);
  if (!args.ok) {
    return failure("invalid_coder_args", args.message, ExitCode.InvalidInput);
  }
  return { ok: true, value: { command, args: args.value ?? ["-p"] } };
}

function parseArgsJson(
  value: undefined | string,
): { ok: true; value: null | string[] } | { ok: false; message: string } {
  if (!value) return { ok: true, value: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    return {
      ok: false,
      message: `ANCHORAGE_CODER_ARGS_JSON is not valid JSON: ${(error as Error).message}`,
    };
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    return { ok: false, message: "ANCHORAGE_CODER_ARGS_JSON must be a JSON string array." };
  }
  return { ok: true, value: parsed };
}

function buildCoderPrompt(plan: ImplementationPlan): string {
  return `You are the coder agent in the Anchorage workflow.

Apply this implementation plan to the current repository worktree. Keep the diff scoped to the plan. Do not commit, push, or open a PR. If the plan is impossible or unsafe, stop and explain the blocker.

Return a concise summary of what changed and any commands you ran.

Implementation plan JSON:
${JSON.stringify(plan, null, 2)}
`;
}

async function runCommand(
  command: CoderCommand,
  prompt: string,
  workspacePath: string,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command.command, [...command.args, prompt], {
      cwd: workspacePath,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      resolve({ exitCode: 127, stdout: "", stderr: error.message });
    });
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
  return runRawCommand("git", ["status", "--short"], workspacePath);
}

async function runRawCommand(
  command: string,
  args: string[],
  workspacePath: string,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: workspacePath, stdio: ["ignore", "pipe", "pipe"] });
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

function changedFilesFromStatus(status: string): string[] {
  return status
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(isString);
}

function redactPromptArg(args: string[]): string[] {
  return [...args, "<prompt>"];
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

function truncate(value: string): string {
  const maxLength = Number(process.env.ANCHORAGE_CODER_OUTPUT_LIMIT ?? 12000);
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} bytes]`;
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

interface CoderCommand {
  command: string;
  args: string[];
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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
  beforeStatus: string;
  afterStatus: string;
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
};

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
