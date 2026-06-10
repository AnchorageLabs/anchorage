#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  buildRevisionRequest,
  ExitCode,
  type ProtocolEvent,
  REVISION_REQUEST_ARTIFACT_TYPE,
  type RevisionRequest,
  type TaskEnvelope,
  validateTaskEnvelope,
} from "@anchorage/sdk";
import { Octokit } from "@octokit/rest";

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

  // Resolution order: explicit input.commands win; with none provided, detect
  // the project's own test command from its manifests. A run must never "pass"
  // by silently executing nothing — if detection also finds nothing, the report
  // says skipped:true out loud (and strict mode refuses to continue).
  let commandSource: "input" | "detected" = "input";
  let commands = parseCommands(task.value.input.commands ?? task.value.input.checks);
  if (!commands.ok && commands.code === "missing_commands") {
    const detected = await detectTestCommands(workspacePath);
    if (detected.length > 0) {
      commandSource = "detected";
      commands = { ok: true, value: detected };
      emit(
        task.value,
        "agent.output",
        "info",
        "No test commands provided; detected from project manifests",
        { detectedCommands: detected.map((c) => ({ name: c.name, command: c.command })) },
      );
    } else {
      const strict = /^(true|1|yes|on)$/i.test(
        (process.env.ANCHORAGE_TESTER_REQUIRE_TESTS ?? "").trim(),
      );
      const report: TestReport = {
        passed: !strict,
        skipped: true,
        skipReason:
          "No test commands were provided and none could be detected from the repository manifests.",
        checkedAt: new Date().toISOString(),
        results: [],
      };
      emit(
        task.value,
        "agent.output",
        "warn",
        "TESTS SKIPPED — nothing was executed. The pipeline's test gate did not verify this change.",
        report,
      );
      const skippedArtifact = await writeArtifact(task.value, report);
      emit(task.value, "artifact.created", "info", "Test report artifact created", skippedArtifact);
      if (strict) {
        emit(task.value, "agent.failed", "error", "No tests to run (strict mode)", {
          error: {
            code: "no_tests_found",
            message:
              "ANCHORAGE_TESTER_REQUIRE_TESTS is set and no test commands were provided or detected.",
          },
          artifact: skippedArtifact,
        });
        return ExitCode.PartialSuccessAttentionRequired;
      }
      emit(task.value, "agent.completed", "warn", "tester completed WITHOUT running any tests", {
        artifact: skippedArtifact,
        skipped: true,
      });
      return ExitCode.Success;
    }
  }
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
    commandSource,
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

  // Post test summary to the source issue when github.write is granted.
  await maybePostTestComment(task.value, report);

  if (!report.passed) {
    // Emit a revision request alongside the report so the orchestrator can loop
    // the failures back to the coder instead of failing the run outright. The
    // exit code stays PartialSuccessAttentionRequired — the orchestrator decides
    // whether a feedback loop is configured for this step.
    const revisionArtifact = await writeRevisionArtifact(task.value, report);
    emit(
      task.value,
      "artifact.created",
      "info",
      "Revision request artifact created",
      revisionArtifact,
    );

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

// ── Test-command detection ────────────────────────────────────────────────────
// Mirrors the manifest knowledge in agent-llm's detect_project, kept local so
// the deterministic tester stays dependency-light. First match wins; every
// command is the ecosystem's own idiom, never an invented script.

const NPM_PLACEHOLDER_TEST = /echo .Error: no test specified./;

async function detectTestCommands(workspacePath: string): Promise<TestCommand[]> {
  const read = async (rel: string): Promise<string | null> =>
    fs.readFile(path.join(workspacePath, rel), "utf8").catch(() => null);
  const exists = async (rel: string): Promise<boolean> =>
    fs
      .stat(path.join(workspacePath, rel))
      .then(() => true)
      .catch(() => false);

  const packageJsonRaw = await read("package.json");
  if (packageJsonRaw) {
    try {
      const manifest = JSON.parse(packageJsonRaw) as {
        scripts?: Record<string, string>;
        packageManager?: string;
      };
      const script = manifest.scripts?.test;
      if (script && !NPM_PLACEHOLDER_TEST.test(script)) {
        const pm = manifest.packageManager?.startsWith("pnpm")
          ? "pnpm"
          : manifest.packageManager?.startsWith("yarn")
            ? "yarn"
            : (await exists("pnpm-lock.yaml"))
              ? "pnpm"
              : (await exists("yarn.lock"))
                ? "yarn"
                : "npm";
        return [{ name: "test", command: `${pm} test` }];
      }
    } catch {
      // unparseable manifest — fall through to other ecosystems
    }
  }

  if (await exists("go.mod")) return [{ name: "go-test", command: "go test ./..." }];
  if (await exists("Cargo.toml")) return [{ name: "cargo-test", command: "cargo test" }];
  if (await exists("mix.exs")) return [{ name: "mix-test", command: "mix test" }];
  if ((await exists("pytest.ini")) || (await exists("tests")) || (await exists("test"))) {
    const pyproject = await read("pyproject.toml");
    if (pyproject !== null || (await exists("pytest.ini")) || (await exists("setup.py"))) {
      return [{ name: "pytest", command: "python -m pytest -q" }];
    }
  }
  const makefile = await read("Makefile");
  if (makefile && /^test:/m.test(makefile)) return [{ name: "make-test", command: "make test" }];

  return [];
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

async function maybePostTestComment(task: TaskEnvelope, report: TestReport): Promise<void> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const hasGithubWrite =
    Array.isArray(task.capabilities) && task.capabilities.includes("github.write");
  if (!hasGithubWrite || !token || !task.repository) return;

  // Resolve issue number from prior code.change.result artifact or input.
  const issueNumber = await resolveIssueNumber(task);
  if (!issueNumber) return;

  const { owner, name: repo } = task.repository;
  const body = buildTestComment(report);

  emit(task, "tool.requested", "info", `Posting test summary to issue #${issueNumber}`, {
    tool: "github.issues.createComment",
    input: { owner, repo, issue_number: issueNumber },
  });

  try {
    const octokit = new Octokit({ auth: token });
    await octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body });
    emit(task, "tool.result", "info", "Test comment posted", {
      tool: "github.issues.createComment",
      success: true,
      output: { issueNumber },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(task, "tool.result", "error", "Test comment failed (non-fatal)", {
      tool: "github.issues.createComment",
      success: false,
      error: { code: "github_comment_failed", message },
    });
    // Non-fatal.
  }
}

async function resolveIssueNumber(task: TaskEnvelope): Promise<null | number> {
  // Try prior code.change.result artifact.
  const artifact = task.context?.priorArtifacts?.find(
    (a) => a.artifactType === "code.change.result",
  );
  if (artifact?.uri.startsWith("file://")) {
    try {
      const raw = await fs.readFile(new URL(artifact.uri), "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed?.issueNumber === "number" && parsed.issueNumber > 0) {
        return parsed.issueNumber;
      }
      // Try planId extraction: plan_run_envy_N_timestamp_N
      if (typeof parsed?.planId === "string") {
        const match = (parsed.planId as string).match(/_(\d+)$/);
        if (match?.[1]) return Number(match[1]);
      }
    } catch {
      // fall through
    }
  }
  return null;
}

function buildTestComment(report: TestReport): string {
  const icon = report.passed ? "✅" : "❌";
  const status = report.passed ? "All tests passed" : "Tests failed";
  const lines: string[] = [];
  lines.push(`## ${icon} Anchorage Test Report — ${status}`);
  lines.push("");
  lines.push(`Ran ${report.results.length} command(s) at ${report.checkedAt}.`);
  lines.push("");
  lines.push("| Command | Status | Duration |");
  lines.push("|---|---|---|");
  for (const r of report.results) {
    const s = r.passed ? "✅ passed" : "❌ failed";
    lines.push(`| \`${r.name}\` | ${s} | ${r.durationMs}ms |`);
  }
  const failed = report.results.filter((r) => !r.passed);
  if (failed.length > 0) {
    lines.push("");
    lines.push("### Failures");
    lines.push("");
    for (const r of failed) {
      lines.push(`<details><summary><code>${r.name}</code></summary>`);
      lines.push("");
      if (r.stderr) {
        lines.push("**stderr:**");
        lines.push("```");
        lines.push(r.stderr.slice(0, 1500));
        lines.push("```");
      }
      if (r.stdout) {
        lines.push("**stdout:**");
        lines.push("```");
        lines.push(r.stdout.slice(0, 1500));
        lines.push("```");
      }
      lines.push("</details>");
      lines.push("");
    }
  }
  lines.push("---");
  lines.push("*Posted by [tester](https://github.com/AnchorageLabs/anchorage) agent.*");
  return lines.join("\n");
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

async function writeRevisionArtifact(task: TaskEnvelope, report: TestReport) {
  const failed = report.results.filter((result) => !result.passed);
  const revision: RevisionRequest = buildRevisionRequest({
    fromAgent: "tester",
    reason: "test_failed",
    summary:
      failed.length === report.results.length
        ? `All ${report.results.length} command(s) failed`
        : `${failed.length} of ${report.results.length} command(s) failed`,
    failures: failed.map((result) => ({
      name: result.name,
      command: result.command,
      details: result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`,
    })),
  });

  const artifactRoot =
    process.env.ANCHORAGE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "anchorage-agent-artifacts", task.run.id);
  await fs.mkdir(artifactRoot, { recursive: true });
  const artifactPath = path.join(artifactRoot, "revision-request.json");
  const content = `${JSON.stringify(revision, null, 2)}\n`;
  await fs.writeFile(artifactPath, content, "utf8");
  return {
    artifactType: REVISION_REQUEST_ARTIFACT_TYPE,
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
  /** "input" = commands came from the envelope; "detected" = from manifests. */
  commandSource?: "input" | "detected";
  /** True when nothing was executed — the gate verified NOTHING for this run. */
  skipped?: boolean;
  skipReason?: string;
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
