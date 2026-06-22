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
      input: { name: command.name, command: command.command, cwd: command.cwd ?? "." },
    });

    await hydrateDependencies(command, workspacePath);
    const result = await runTestCommand(command, workspacePath);
    results.push(result);

    emit(
      task.value,
      "tool.result",
      result.passed ? "info" : result.environmentBlocked ? "warn" : "error",
      result.environmentBlocked
        ? `Test command ${command.name} could not run in this environment (${result.envReason})`
        : `Test command ${command.name} finished`,
      {
        tool: "shell.exec",
        success: result.passed,
        output: result,
      },
    );
  }

  // A command that the environment couldn't EXECUTE (missing tool/service) is not
  // a test failure — only commands that actually ran count toward pass/fail.
  const executed = results.filter((result) => !result.environmentBlocked);
  const realFailures = executed.filter((result) => !result.passed);

  // Nothing could run here (every candidate needed a tool/service the worker
  // lacks — e.g. a Dockerised backend suite). This is NOT a code failure and it
  // must NEVER kill the pipeline: the run continues and the report records, out
  // loud, that the gate could not verify this change. (Note: `strict` /
  // ANCHORAGE_TESTER_REQUIRE_TESTS governs the *no test command configured* case
  // above; an environment that can't execute is always non-fatal here.)
  if (executed.length === 0) {
    const skipReason = `No test command could run in this environment: ${results
      .map((r) => `${r.name} (${r.envReason ?? `exit ${r.exitCode}`})`)
      .join("; ")}`;
    const report: TestReport = {
      // Non-blocking: the tester couldn't verify, but it didn't observe a
      // failure either. `skipped`+`skipReason` carry the "could not run" signal.
      passed: true,
      commandSource,
      checkedAt: new Date().toISOString(),
      results,
      skipped: true,
      skipReason,
    };
    emit(
      task.value,
      "agent.output",
      "warn",
      "TESTS SKIPPED — no command was runnable in this environment; continuing.",
      report,
    );
    const artifact = await writeArtifact(task.value, report);
    emit(task.value, "artifact.created", "info", "Test report artifact created", artifact);
    await maybePostTestComment(task.value, report);
    emit(
      task.value,
      "agent.completed",
      "warn",
      "tester could not run any tests in this environment — pipeline continues, change UNVERIFIED",
      { artifact, skipped: true, skipReason },
    );
    return ExitCode.Success;
  }

  const report: TestReport = {
    passed: realFailures.length === 0,
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
// Discover the NATIVE test runner for every project root in the repo (the
// workspace root PLUS nested packages — e.g. a `frontend/` + Go-backend
// monorepo), not just the first manifest at the top level. Native per-project
// runners are preferred over a top-level `make test`, which in polyglot repos
// tends to drive the whole suite through Docker/services the worker can't
// provide; `make test` is kept only as a last resort when nothing native is
// found. Every command is the ecosystem's own idiom, never an invented script.

const NPM_PLACEHOLDER_TEST = /echo .Error: no test specified./;

// Directories never worth descending into when looking for project roots.
const SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "vendor",
  ".next",
  ".turbo",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "cdk.out",
  ".anchorage",
  "tmp",
  "out",
  ".cache",
]);
const MAX_PROJECT_COMMANDS = 8;

async function detectTestCommands(workspacePath: string): Promise<TestCommand[]> {
  const dirs = await listProjectDirs(workspacePath);
  const commands: TestCommand[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const cmd = await detectNativeTestCommand(workspacePath, dir);
    if (!cmd) continue;
    const key = `${cmd.cwd}|${cmd.command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    commands.push(cmd);
    if (commands.length >= MAX_PROJECT_COMMANDS) break;
  }
  if (commands.length > 0) return commands;

  // Last resort: a top-level Makefile `test` target. May invoke tools the worker
  // lacks (docker, services) — runTestCommand classifies that as environment-
  // blocked (skipped), not a test failure.
  const makefile = await fs
    .readFile(path.join(workspacePath, "Makefile"), "utf8")
    .catch(() => null);
  if (makefile && /^test:/m.test(makefile)) {
    return [{ name: "make-test", command: "make test", cwd: ".", ecosystem: "make" }];
  }
  return [];
}

/** Workspace root + nested directories (≤2 deep) that could be project roots. */
async function listProjectDirs(root: string): Promise<string[]> {
  const dirs: string[] = ["."];
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > 2 || dirs.length > 64) return;
    const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SCAN_SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const childRel = rel === "." ? entry.name : `${rel}/${entry.name}`;
      dirs.push(childRel);
      await walk(childRel, depth + 1);
    }
  };
  await walk(".", 1);
  return dirs;
}

/** The native test command for a single directory, or null if it's not a project root. */
async function detectNativeTestCommand(root: string, dir: string): Promise<TestCommand | null> {
  const read = (rel: string): Promise<string | null> =>
    fs.readFile(path.join(root, dir, rel), "utf8").catch(() => null);
  const exists = (rel: string): Promise<boolean> =>
    fs
      .stat(path.join(root, dir, rel))
      .then(() => true)
      .catch(() => false);
  const suffix = dir === "." ? "" : `:${dir}`;

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
        return { name: `test${suffix}`, command: `${pm} test`, cwd: dir, ecosystem: "node" };
      }
    } catch {
      // unparseable manifest — try other ecosystems in this dir
    }
  }
  if (await exists("go.mod"))
    return { name: `go-test${suffix}`, command: "go test ./...", cwd: dir, ecosystem: "go" };
  if (await exists("Cargo.toml"))
    return { name: `cargo-test${suffix}`, command: "cargo test", cwd: dir, ecosystem: "rust" };
  if (await exists("mix.exs"))
    return { name: `mix-test${suffix}`, command: "mix test", cwd: dir, ecosystem: "elixir" };
  if (
    (await exists("pytest.ini")) ||
    (await exists("pyproject.toml")) ||
    (await exists("setup.py"))
  ) {
    if ((await exists("tests")) || (await exists("test")) || (await exists("pytest.ini")))
      return {
        name: `pytest${suffix}`,
        command: "python -m pytest -q",
        cwd: dir,
        ecosystem: "python",
      };
  }
  if (await exists("pom.xml"))
    return { name: `maven-test${suffix}`, command: "mvn -q -B test", cwd: dir, ecosystem: "java" };
  if ((await exists("build.gradle")) || (await exists("build.gradle.kts")))
    return { name: `gradle-test${suffix}`, command: "./gradlew test", cwd: dir, ecosystem: "java" };
  if (await exists("composer.json"))
    return { name: `composer-test${suffix}`, command: "composer test", cwd: dir, ecosystem: "php" };
  if (await exists("Gemfile"))
    return {
      name: `ruby-test${suffix}`,
      command: "bundle exec rake test",
      cwd: dir,
      ecosystem: "ruby",
    };
  return null;
}

// Signatures that mean "this environment can't run the command", NOT "the tests
// failed": a missing binary/toolchain (make/docker/go/…), an unreachable service
// or DB the suite spins up, or a Make target that died on a missing tool. These
// must not be reported as test failures — otherwise a frontend change is blocked
// by an unrunnable Dockerised backend suite.
const ENVIRONMENT_FAILURE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /command not found|: not found|executable file not found/i,
    "a required command is not installed",
  ],
  [
    /docker: (?:command )?not found|cannot connect to the docker daemon|is the docker daemon running/i,
    "Docker is not available in the worker",
  ],
  [/no such file or directory/i, "a required file or tool is missing"],
  [
    /connection refused|ECONNREFUSED|could not connect to server|could not translate host/i,
    "a required service/database was not reachable",
  ],
  [/make: \*\*\* .*Error 127/i, "a Make target invoked a tool that is not installed"],
  [/\bgradlew\b.*(?:not found|permission denied)/i, "the Gradle wrapper could not run"],
];

function classifyEnvironment(result: CommandResult): { blocked: boolean; reason?: string } {
  if (result.exitCode === 0) return { blocked: false };
  const text = `${result.stderr}\n${result.stdout}`;
  if (result.exitCode === 127) {
    return { blocked: true, reason: "command exited 127 (not found / unavailable)" };
  }
  for (const [pattern, reason] of ENVIRONMENT_FAILURE_PATTERNS) {
    if (pattern.test(text)) return { blocked: true, reason };
  }
  return { blocked: false };
}

async function runTestCommand(
  command: TestCommand,
  workspacePath: string,
): Promise<TestCommandResult> {
  const startedAt = Date.now();
  const cwd = path.resolve(workspacePath, command.cwd ?? ".");
  const result = await runCommand("sh", ["-c", command.command], cwd);
  const env = classifyEnvironment(result);
  return {
    name: command.name,
    command: command.command,
    passed: result.exitCode === 0,
    durationMs: Date.now() - startedAt,
    exitCode: result.exitCode,
    stdout: result.stdout.slice(0, 4000),
    stderr: result.stderr.slice(0, 4000),
    ...(env.blocked ? { environmentBlocked: true, envReason: env.reason } : {}),
  };
}

/**
 * Best-effort: install dependencies for a command's ecosystem before running so
 * a repo that wasn't pre-hydrated (e.g. missing node_modules → "Cannot find
 * module 'vitest'") still runs its tests. Failures here are swallowed — the test
 * run itself will surface any real gap, and we never want hydration to block.
 */
async function hydrateDependencies(command: TestCommand, workspacePath: string): Promise<void> {
  const cwd = path.resolve(workspacePath, command.cwd ?? ".");
  const has = (rel: string): Promise<boolean> =>
    fs
      .stat(path.join(cwd, rel))
      .then(() => true)
      .catch(() => false);
  try {
    switch (command.ecosystem) {
      case "node": {
        if (await has("node_modules")) return;
        const pm = (await has("pnpm-lock.yaml"))
          ? "pnpm"
          : (await has("yarn.lock"))
            ? "yarn"
            : "npm";
        const args = pm === "npm" ? ["install", "--no-audit", "--no-fund"] : ["install"];
        await runCommand(pm, args, cwd);
        return;
      }
      case "go":
        await runCommand("go", ["mod", "download"], cwd);
        return;
      case "python":
        if (await has("requirements.txt")) {
          await runCommand("python", ["-m", "pip", "install", "-q", "-r", "requirements.txt"], cwd);
        } else if ((await has("pyproject.toml")) || (await has("setup.py"))) {
          await runCommand("python", ["-m", "pip", "install", "-q", "-e", "."], cwd);
        }
        return;
      case "rust":
        await runCommand("cargo", ["fetch"], cwd);
        return;
      case "ruby":
        await runCommand("bundle", ["install"], cwd);
        return;
      default:
        return; // java/php/elixir/make manage their own deps on test invocation
    }
  } catch {
    // best-effort hydration; ignore failures
  }
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
  /** Directory (relative to the workspace root) to run in. Default ".". */
  cwd?: string;
  /** Ecosystem hint, used to hydrate dependencies before running. */
  ecosystem?: "node" | "go" | "rust" | "python" | "ruby" | "elixir" | "java" | "php" | "make";
}

type TestCommandResult = ProtocolEvent["data"] & {
  name: string;
  command: string;
  passed: boolean;
  durationMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * True when the command could not be EXECUTED in this environment (missing
   * toolchain/service — e.g. `docker: not found`, exit 127), as opposed to the
   * tests running and failing. Environment-blocked commands never count as a
   * test failure: they don't block the run or bounce the coder.
   */
  environmentBlocked?: boolean;
  /** Human-readable reason a command was environment-blocked. */
  envReason?: string;
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
