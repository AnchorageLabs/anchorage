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

  if (task.value.task.type !== "smoke_test.run") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `smoke-test-runner only supports smoke_test.run, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "smoke-test-runner started", { agentVersion });

  const checks = parseChecks(task.value.input.checks);
  if (!checks.ok) return fail(task.value, checks);

  const workspacePath =
    typeof task.value.input.workspacePath === "string" && task.value.input.workspacePath.trim()
      ? task.value.input.workspacePath.trim()
      : undefined;

  const results: SmokeCheckResult[] = [];
  for (const check of checks.value) {
    emit(task.value, "tool.requested", "info", `Running smoke check ${check.name}`, {
      tool: check.type === "http" ? "http.fetch" : "shell.exec",
      input: sanitizeCheckForEvent(check),
    });
    const result =
      check.type === "http" ? await runHttpCheck(check) : await runShellCheck(check, workspacePath);
    results.push(result);
    emit(
      task.value,
      "tool.result",
      result.passed ? "info" : "error",
      `Smoke check ${check.name} finished`,
      {
        tool: check.type === "http" ? "http.fetch" : "shell.exec",
        success: result.passed,
        output: result,
      },
    );
  }

  const report: SmokeTestReport = {
    passed: results.every((result) => result.passed),
    checkedAt: new Date().toISOString(),
    results,
  };

  emit(
    task.value,
    "agent.output",
    report.passed ? "info" : "error",
    "Smoke test report prepared",
    report,
  );
  const artifact = await writeArtifact(task.value, report);
  emit(task.value, "artifact.created", "info", "Smoke test report artifact created", artifact);

  if (!report.passed) {
    emit(task.value, "agent.failed", "error", "One or more smoke checks failed", {
      error: { code: "smoke_test_failed", message: "One or more smoke checks failed." },
      artifact,
    });
    return ExitCode.PartialSuccessAttentionRequired;
  }

  emit(task.value, "agent.completed", "info", "smoke-test-runner completed successfully", {
    artifact,
  });
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

function parseChecks(
  value: JsonValue | undefined,
): { ok: true; value: SmokeCheck[] } | SmokeFailure {
  if (!Array.isArray(value) || value.length === 0) {
    return failure(
      "missing_checks",
      "smoke-test-runner requires a non-empty input.checks array.",
      ExitCode.InvalidInput,
    );
  }

  const checks: SmokeCheck[] = [];
  for (const candidate of value) {
    if (!isObject(candidate)) continue;
    const name = readString(candidate.name) ?? `check_${checks.length + 1}`;
    const type = readString(candidate.type);
    if (type === "http") {
      const url = readString(candidate.url);
      if (!url) continue;
      checks.push({
        type,
        name,
        url,
        expectedStatus: readNumber(candidate.expectedStatus) ?? 200,
      });
    }
    if (type === "shell") {
      const command = readString(candidate.command);
      if (!command) continue;
      checks.push({
        type,
        name,
        command,
        args: Array.isArray(candidate.args) ? candidate.args.filter(isString) : [],
      });
    }
  }

  if (checks.length === 0) {
    return failure(
      "invalid_checks",
      "input.checks did not include a valid http or shell check.",
      ExitCode.InvalidInput,
    );
  }

  return { ok: true, value: checks };
}

async function runHttpCheck(check: HttpCheck): Promise<SmokeCheckResult> {
  const startedAt = Date.now();
  try {
    const response = await fetch(check.url, { method: "GET" });
    return {
      name: check.name,
      type: check.type,
      passed: response.status === check.expectedStatus,
      durationMs: Date.now() - startedAt,
      status: response.status,
      expectedStatus: check.expectedStatus,
    };
  } catch (error) {
    return {
      name: check.name,
      type: check.type,
      passed: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runShellCheck(
  check: ShellCheck,
  workspacePath: string | undefined,
): Promise<SmokeCheckResult> {
  const startedAt = Date.now();
  const result = await runCommand("sh", ["-c", check.command], workspacePath);
  return {
    name: check.name,
    type: check.type,
    passed: result.exitCode === 0,
    durationMs: Date.now() - startedAt,
    exitCode: result.exitCode,
    stdout: result.stdout.slice(0, 4000),
    stderr: result.stderr.slice(0, 4000),
  };
}

async function runCommand(command: string, args: string[], cwd?: string): Promise<CommandResult> {
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

async function writeArtifact(task: TaskEnvelope, report: SmokeTestReport) {
  const artifactRoot =
    process.env.ANCHORAGE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "anchorage-agent-artifacts", task.run.id);
  await fs.mkdir(artifactRoot, { recursive: true });
  const artifactPath = path.join(artifactRoot, "smoke-test-report.json");
  const content = `${JSON.stringify(report, null, 2)}\n`;
  await fs.writeFile(artifactPath, content, "utf8");
  return {
    artifactType: "smoke_test.report",
    uri: `file://${artifactPath}`,
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(content),
  };
}

function sanitizeCheckForEvent(check: SmokeCheck): ProtocolEvent["data"] {
  if (check.type === "http") return { name: check.name, type: check.type, url: check.url };
  return { name: check.name, type: check.type, command: check.command, args: check.args };
}

function fail(task: TaskEnvelope, failureValue: SmokeFailure): number {
  emit(task, "agent.failed", "error", failureValue.message, {
    error: { code: failureValue.code, message: failureValue.message },
  });
  return failureValue.exitCode;
}

function failure(code: string, message: string, exitCode: number): SmokeFailure {
  return { ok: false, code, message, exitCode };
}

function readString(value: JsonValue | undefined): null | string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: JsonValue | undefined): null | number {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

interface SmokeFailure extends AgentFailure {
  code: string;
  message: string;
}

interface BaseCheck {
  name: string;
}

interface HttpCheck extends BaseCheck {
  type: "http";
  url: string;
  expectedStatus: number;
}

interface ShellCheck extends BaseCheck {
  type: "shell";
  command: string;
  args: string[];
}

type SmokeCheck = HttpCheck | ShellCheck;

type SmokeCheckResult = ProtocolEvent["data"] & {
  name: string;
  type: string;
  passed: boolean;
  durationMs: number;
};

type SmokeTestReport = ProtocolEvent["data"] & {
  passed: boolean;
  checkedAt: string;
  results: SmokeCheckResult[];
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
