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
  const task = parseTask(readFileSync(0, "utf8"));
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "test.run") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `tester only supports test.run, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "tester started", { agentVersion });

  const workspacePath = resolveWorkspacePath(task.value.input.workspacePath);
  if (!workspacePath) {
    return fail(
      task.value,
      failure(
        "missing_workspace_path",
        "tester requires input.workspacePath pointing at the repository worktree.",
        ExitCode.InvalidInput,
      ),
    );
  }

  const workspaceStat = await fs.stat(workspacePath).catch(() => null);
  if (!workspaceStat?.isDirectory()) {
    return fail(
      task.value,
      failure(
        "invalid_workspace_path",
        "input.workspacePath must be a directory.",
        ExitCode.InvalidInput,
      ),
    );
  }

  const commands = parseCommands(task.value.input.commands ?? task.value.input.checks);
  if (!commands.ok) return fail(task.value, commands);

  const results: TestCommandResult[] = [];
  for (const command of commands.value) {
    emit(task.value, "tool.requested", "info", `Running test command ${command.name}`, {
      tool: "shell.exec",
      input: { name: command.name, command: command.command },
    });

    const result = await runTestCommand(command, workspacePath);
    results.push(result);

    emit(
      task.value,
      "tool.result",
      result.passed ? "info" : "error",
      `Test command ${command.name} finished`,
      {
        tool: "shell.exec",
        success: result.passed,
        output: result,
      },
    );
  }

  const report: TestReport = {
    passed: results.every((result) => result.passed),
    checkedAt: new Date().toISOString(),
    results,
  };

  emit(
    task.value,
    "agent.output",
    report.passed ? "info" : "error",
    "Test report prepared",
    report,
  );
  const artifact = await writeArtifact(task.value, report);
  emit(task.value, "artifact.created", "info", "Test report artifact created", artifact);

  if (!report.passed) {
    emit(task.value, "agent.failed", "error", "One or more test commands failed", {
      error: { code: "test_failed", message: "One or more test commands failed." },
      artifact,
    });
    return ExitCode.PartialSuccessAttentionRequired;
  }

  emit(task.value, "agent.completed", "info", "tester completed successfully", { artifact });
  return ExitCode.Success;
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

function resolveWorkspacePath(value: JsonValue | undefined): null | string {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return path.resolve(process.cwd(), value);
}

function parseCommands(
  value: JsonValue | undefined,
): { ok: true; value: TestCommand[] } | TesterFailure {
  if (!Array.isArray(value) || value.length === 0) {
    return failure(
      "missing_commands",
      "tester requires a non-empty input.commands array.",
      ExitCode.InvalidInput,
    );
  }

  const commands: TestCommand[] = [];
  for (const candidate of value) {
    if (!isObject(candidate)) continue;
    const command = readString(candidate.command);
    if (!command) continue;
    commands.push({
      name: readString(candidate.name) ?? `command_${commands.length + 1}`,
      command,
    });
  }

  if (commands.length === 0) {
    return failure(
      "invalid_commands",
      "input.commands did not include any valid test command.",
      ExitCode.InvalidInput,
    );
  }

  return { ok: true, value: commands };
}

async function runTestCommand(
  command: TestCommand,
  workspacePath: string,
): Promise<TestCommandResult> {
  const startedAt = Date.now();
  const result = await runCommand("sh", ["-c", command.command], workspacePath);
  return {
    name: command.name,
    command: command.command,
    passed: result.exitCode === 0,
    durationMs: Date.now() - startedAt,
    exitCode: result.exitCode,
    stdout: result.stdout.slice(0, 4000),
    stderr: result.stderr.slice(0, 4000),
  };
}

async function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
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

async function writeArtifact(task: TaskEnvelope, report: TestReport) {
  const artifactRoot =
    process.env.ANCHORAGE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "anchorage-agent-artifacts", task.run.id);
  await fs.mkdir(artifactRoot, { recursive: true });
  const artifactPath = path.join(artifactRoot, "test-report.json");
  const content = `${JSON.stringify(report, null, 2)}\n`;
  await fs.writeFile(artifactPath, content, "utf8");
  return {
    artifactType: "test.report",
    uri: `file://${artifactPath}`,
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(content),
  };
}

function fail(task: TaskEnvelope, failureValue: TesterFailure): number {
  emit(task, "agent.failed", "error", failureValue.message, {
    error: { code: failureValue.code, message: failureValue.message },
  });
  return failureValue.exitCode;
}

function failure(code: string, message: string, exitCode: number): TesterFailure {
  return { ok: false, code, message, exitCode };
}

function readString(value: JsonValue | undefined): null | string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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

interface TesterFailure extends AgentFailure {
  code: string;
  message: string;
}

interface TestCommand {
  name: string;
  command: string;
}

type TestCommandResult = ProtocolEvent["data"] & {
  name: string;
  command: string;
  passed: boolean;
  durationMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
};

type TestReport = ProtocolEvent["data"] & {
  passed: boolean;
  checkedAt: string;
  results: TestCommandResult[];
};

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
