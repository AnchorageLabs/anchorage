#!/usr/bin/env node
import { spawn } from "node:child_process";
import { openSync, readFileSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  buildRuntimePreview,
  ExitCode,
  type ProtocolEvent,
  RUNTIME_PREVIEW_ARTIFACT_TYPE,
  type RuntimePreview,
  type RuntimeStrategy,
  type TaskEnvelope,
  validateTaskEnvelope,
} from "@anchorage/sdk";

type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonObject | JsonValue[] | boolean | null | number | string;

const agentVersion = "0.1.0";
let eventSequence = 0;

// Where the runtime agent remembers the working local-run strategy, relative to
// the repository root. First run detects + writes it; later runs read it first.
const ANCHORAGE_DIR = ".anchorage";
const CACHE_FILE = "runtime.json";
const LOG_FILE = "runtime.log";
const DEFAULT_NODE_PREVIEW_PORT = 3100;

// Readiness budgets per strategy. A docker-compose stack may need to build
// images; a static server is up almost immediately.
const READY_TIMEOUT_MS: Record<string, number> = {
  "docker-compose": 180_000,
  node: 90_000,
  static: 20_000,
};
const READY_POLL_MS = 1_000;
const INSTALL_TIMEOUT_MS = Number(process.env.ANCHORAGE_RUNTIME_INSTALL_TIMEOUT_MS ?? 300_000);

async function main(): Promise<number> {
  const task = parseTask(readFileSync(0, "utf8"));
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "runtime.start") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `runtime only supports runtime.start, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "runtime started", { agentVersion });

  const workspacePath = resolveWorkspacePath(task.value.input.workspacePath);
  if (!workspacePath) {
    return fail(
      task.value,
      "missing_workspace_path",
      "runtime requires input.workspacePath pointing at the repository worktree.",
      ExitCode.InvalidInput,
    );
  }
  const workspaceStat = await fs.stat(workspacePath).catch(() => null);
  if (!workspaceStat?.isDirectory()) {
    return fail(
      task.value,
      "invalid_workspace_path",
      "input.workspacePath must be a directory.",
      ExitCode.InvalidInput,
    );
  }

  // ── Is there anything to preview? ───────────────────────────────────────────
  // The runtime gate is intentionally optional. A documentation-only change has
  // nothing to run, so we skip straight through without pausing the pipeline.
  const changedFiles = await changedFilesFromArtifacts(task.value);
  if (changedFiles && changedFiles.length > 0 && isDocsOnly(changedFiles)) {
    return finishNotApplicable(
      task.value,
      `Change touches only documentation/non-code files (${changedFiles.length} file(s)); nothing to run locally.`,
    );
  }

  // ── Resolve a run strategy: cache first, then detection ──────────────────────
  let strategy = await readCache(workspacePath);
  if (strategy) {
    const staleReason = await staleCachedStrategyReason(workspacePath, strategy);
    if (staleReason) {
      emit(task.value, "agent.progress", "warn", "Ignoring stale cached runtime strategy", {
        reason: staleReason,
        strategy: strategy as unknown as JsonValue,
      });
      strategy = null;
    } else {
      emit(task.value, "agent.progress", "info", "Using cached runtime strategy", {
        strategy: strategy as unknown as JsonValue,
      });
    }
  }

  if (!strategy) {
    strategy = await detectStrategy(workspacePath);
    if (strategy) {
      emit(task.value, "agent.progress", "info", `Detected runtime strategy: ${strategy.kind}`, {
        strategy: strategy as unknown as JsonValue,
      });
      // Persist the freshly detected candidate before starting it. If a previous
      // cache was stale, this overwrites the bad guide even when startup later
      // fails, so the repo does not keep teaching future runs the wrong command.
      await writeCache(task.value, workspacePath, { ...strategy, source: "detected" });
    }
  }

  if (!strategy) {
    return finishNotApplicable(
      task.value,
      "No recognized way to run this solution locally (no docker-compose, runnable package.json script, or static site). Skipping the runtime gate.",
    );
  }

  // ── Start the solution and wait for a reachable preview ──────────────────────
  const started = await startStrategy(task.value, strategy, workspacePath);
  if (!started.ok) {
    const preview = buildRuntimePreview({
      status: "failed",
      summary: `Runtime failed to start (${strategy.kind}).`,
      strategy,
      ...(strategy.stopCommand ? { stopCommand: strategy.stopCommand } : {}),
      error: started.error,
    });
    await emitPreview(task.value, preview, "error");
    emit(task.value, "agent.failed", "error", "Runtime did not become healthy", {
      error: { code: "runtime_failed", message: started.error },
    });
    // Non-zero so the orchestrator finishes the run without merging.
    return ExitCode.PartialSuccessAttentionRequired;
  }

  const preview = buildRuntimePreview({
    status: "running",
    summary: `Solution is running locally at ${started.previewUrl} — opening it for inspection before merge.`,
    previewUrl: started.previewUrl,
    strategy,
    ...(strategy.stopCommand ? { stopCommand: strategy.stopCommand } : {}),
  });
  await emitPreview(task.value, preview, "info");
  emit(task.value, "agent.completed", "info", "runtime started a local preview", {
    previewUrl: started.previewUrl,
  });
  return ExitCode.Success;
}

// ── Outcomes ────────────────────────────────────────────────────────────────

async function finishNotApplicable(task: TaskEnvelope, summary: string): Promise<number> {
  const preview = buildRuntimePreview({ status: "not_applicable", summary });
  await emitPreview(task, preview, "info");
  emit(task, "agent.completed", "info", "runtime not applicable; continuing", { summary });
  return ExitCode.Success;
}

async function emitPreview(
  task: TaskEnvelope,
  preview: RuntimePreview,
  level: ProtocolEvent["level"],
): Promise<void> {
  emit(task, "agent.output", level, preview.summary, preview as unknown as ProtocolEvent["data"]);
  const artifact = await writeArtifact(task, preview);
  emit(task, "artifact.created", "info", "Runtime preview artifact created", artifact);
}

// ── Change inspection ─────────────────────────────────────────────────────────

const DOC_FILE_PATTERNS = [
  /\.md$/i,
  /\.mdx$/i,
  /\.markdown$/i,
  /\.rst$/i,
  /\.txt$/i,
  /\.adoc$/i,
  /^license$/i,
  /^notice$/i,
  /^authors$/i,
  /^changelog/i,
  /(^|\/)docs?\//i,
  /(^|\/)\.github\//i,
];

function isDocsOnly(files: string[]): boolean {
  return files.every((file) => {
    const base = path.basename(file);
    return DOC_FILE_PATTERNS.some((pattern) => pattern.test(file) || pattern.test(base));
  });
}

/**
 * Best-effort list of files the change touched, read from the coder's
 * `code.change.result` artifact (prefer an explicit fileDiffs[].path list, fall
 * back to parsing the unified diff). Returns null when no change artifact is
 * available — in that case we do not take the docs-only shortcut.
 */
async function changedFilesFromArtifacts(task: TaskEnvelope): Promise<string[] | null> {
  const ref = task.context?.priorArtifacts?.find((a) => a.artifactType === "code.change.result");
  if (!ref?.uri?.startsWith("file://")) return null;
  let content: unknown;
  try {
    content = JSON.parse(await fs.readFile(new URL(ref.uri), "utf8"));
  } catch {
    return null;
  }
  if (!content || typeof content !== "object") return null;
  const record = content as Record<string, unknown>;

  const fileDiffs = record.fileDiffs;
  if (Array.isArray(fileDiffs)) {
    const paths = fileDiffs
      .map((entry) =>
        entry && typeof entry === "object" ? (entry as Record<string, unknown>).path : undefined,
      )
      .filter((p): p is string => typeof p === "string" && p.length > 0);
    if (paths.length > 0) return paths;
  }

  if (typeof record.diff === "string") return parseDiffPaths(record.diff);
  return null;
}

function parseDiffPaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match?.[2]) paths.add(match[2]);
  }
  return [...paths];
}

// ── Strategy cache ────────────────────────────────────────────────────────────

async function readCache(workspacePath: string): Promise<RuntimeStrategy | null> {
  const cachePath = path.join(workspacePath, ANCHORAGE_DIR, CACHE_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(cachePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeStrategy>;
    if (typeof parsed.kind === "string" && typeof parsed.startCommand === "string") {
      return normalizeCachedStrategy({ ...(parsed as RuntimeStrategy), source: "cache" });
    }
  } catch {
    // Corrupt cache — fall back to detection.
  }
  return null;
}

function normalizeCachedStrategy(strategy: RuntimeStrategy): RuntimeStrategy {
  if (strategy.kind !== "node" || !usesDevStart(strategy.startCommand)) return strategy;
  const port =
    Number(process.env.ANCHORAGE_RUNTIME_PORT) ||
    (strategy.port === 3000 || strategy.port === undefined
      ? DEFAULT_NODE_PREVIEW_PORT
      : strategy.port);
  if (strategy.port === port && strategy.url === `http://localhost:${port}`) return strategy;
  return { ...strategy, port, url: `http://localhost:${port}` };
}

async function staleCachedStrategyReason(
  workspacePath: string,
  strategy: RuntimeStrategy,
): Promise<string | null> {
  if (strategy.source !== "cache" || strategy.kind !== "node") return null;
  if (!(await isNextProject(workspacePath))) return null;
  if (!usesProductionStart(strategy.startCommand)) return null;
  const requiredServerFiles = path.join(workspacePath, ".next", "required-server-files.json");
  if (await fileExists(requiredServerFiles)) return null;
  return "cached Next.js production start requires .next/required-server-files.json, but this workspace has no production build";
}

async function isNextProject(workspacePath: string): Promise<boolean> {
  const pkgPath = path.join(workspacePath, "package.json");
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  const deps = {
    ...((pkg.dependencies as Record<string, unknown>) ?? {}),
    ...((pkg.devDependencies as Record<string, unknown>) ?? {}),
  };
  return Object.hasOwn(deps, "next");
}

function usesProductionStart(command: string): boolean {
  return /\bnext\s+start\b/.test(command) || /\brun\s+start\b/.test(command);
}

async function writeCache(
  task: TaskEnvelope,
  workspacePath: string,
  strategy: RuntimeStrategy,
): Promise<void> {
  const dir = path.join(workspacePath, ANCHORAGE_DIR);
  const cachePath = path.join(dir, CACHE_FILE);
  try {
    await fs.mkdir(dir, { recursive: true });
    // Don't persist the volatile source marker.
    const { source: _source, ...persisted } = strategy;
    await fs.writeFile(cachePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    emit(task, "agent.progress", "info", "Persisted runtime strategy to .anchorage/runtime.json", {
      cachePath,
    });
    await commitAndPushRuntimeGuide(task, workspacePath);
  } catch (error) {
    // Non-fatal: a read-only workspace just means no speed-up next time.
    emit(task, "agent.progress", "warn", "Could not persist runtime strategy (non-fatal)", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function commitAndPushRuntimeGuide(task: TaskEnvelope, workspacePath: string): Promise<void> {
  const relativePath = path.posix.join(ANCHORAGE_DIR, CACHE_FILE);

  const add = await runGit(workspacePath, ["add", "--force", "--", relativePath]);
  if (add.exitCode !== 0) {
    emitGitWarning(task, "git.add", "runtime_guide_add_failed", gitMessage(add));
    return;
  }

  const diff = await runGit(workspacePath, ["diff", "--cached", "--quiet", "--", relativePath]);
  if (diff.exitCode === 0) {
    emit(task, "agent.progress", "info", "Runtime guide already up to date in git", {
      path: relativePath,
    });
    return;
  }

  const name = process.env.GIT_AUTHOR_NAME || "Anchorage Agent";
  const email = process.env.GIT_AUTHOR_EMAIL || "agent@anchorage.dev";
  const commit = await runGit(workspacePath, [
    "-c",
    `user.name=${name}`,
    "-c",
    `user.email=${email}`,
    "commit",
    "-m",
    "Record local runtime strategy",
    "--",
    relativePath,
  ]);
  if (commit.exitCode !== 0) {
    emitGitWarning(task, "git.commit", "runtime_guide_commit_failed", gitMessage(commit));
    return;
  }

  const branch = await currentBranch(workspacePath);
  if (!branch) {
    emitGitWarning(
      task,
      "git.push",
      "runtime_guide_push_skipped",
      "could not determine current branch",
    );
    return;
  }

  const push = await pushCurrentBranch(task, workspacePath, branch);
  if (!push.ok) {
    emitGitWarning(task, "git.push", "runtime_guide_push_failed", push.reason);
    return;
  }

  emit(task, "tool.result", "info", "Runtime guide committed and pushed", {
    tool: "git.push",
    success: true,
    output: { path: relativePath, branch },
  });
}

// ── Strategy detection ────────────────────────────────────────────────────────

async function detectStrategy(workspacePath: string): Promise<RuntimeStrategy | null> {
  return (
    (await detectDockerCompose(workspacePath)) ??
    (await detectNode(workspacePath)) ??
    (await detectStatic(workspacePath)) ??
    null
  );
}

async function fileExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

async function detectDockerCompose(workspacePath: string): Promise<RuntimeStrategy | null> {
  const candidates = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
  let found: string | null = null;
  for (const name of candidates) {
    if (await fileExists(path.join(workspacePath, name))) {
      found = name;
      break;
    }
  }
  if (!found) return null;

  const port = await firstComposePort(path.join(workspacePath, found));
  return {
    kind: "docker-compose",
    startCommand: "docker compose up -d --build",
    stopCommand: "docker compose down",
    ...(port ? { port, url: `http://localhost:${port}` } : {}),
  };
}

async function firstComposePort(composePath: string): Promise<number | null> {
  let raw: string;
  try {
    raw = await fs.readFile(composePath, "utf8");
  } catch {
    return null;
  }
  // Match a ports list entry, e.g.  - "3000:3000"  |  - 8080:80  |  - "127.0.0.1:5000:5000".
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*-\s*["']?(?:\d{1,3}(?:\.\d{1,3}){3}:)?(\d+):\d+/);
    if (match?.[1]) {
      const port = Number(match[1]);
      if (port > 0 && port < 65536) return port;
    }
  }
  return null;
}

async function detectNode(workspacePath: string): Promise<RuntimeStrategy | null> {
  const pkgPath = path.join(workspacePath, "package.json");
  if (!(await fileExists(pkgPath))) return null;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
  const script =
    typeof scripts.dev === "string"
      ? "dev"
      : typeof scripts.start === "string"
        ? "start"
        : typeof scripts.serve === "string"
          ? "serve"
          : null;
  if (!script) return null;

  const pm = await detectPackageManager(workspacePath);
  const port =
    Number(process.env.ANCHORAGE_RUNTIME_PORT) || guessNodePort(pkg, String(scripts[script]));
  return {
    kind: "node",
    startCommand: `${pm} run ${script}`,
    port,
    url: `http://localhost:${port}`,
  };
}

async function detectPackageManager(workspacePath: string): Promise<string> {
  if (await fileExists(path.join(workspacePath, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(path.join(workspacePath, "yarn.lock"))) return "yarn";
  if (await fileExists(path.join(workspacePath, "bun.lockb"))) return "bun";
  return "npm";
}

function guessNodePort(pkg: Record<string, unknown>, scriptBody: string): number {
  const portInScript = scriptBody.match(/(?:--port[= ]|-p[= ]|PORT=)(\d+)/);
  if (portInScript?.[1]) return Number(portInScript[1]);

  const deps = {
    ...((pkg.dependencies as Record<string, unknown>) ?? {}),
    ...((pkg.devDependencies as Record<string, unknown>) ?? {}),
  };
  const has = (name: string) =>
    Object.keys(deps).some((d) => d === name || d.startsWith(`${name}/`));
  if (has("vite")) return 5173;
  if (has("@angular-devkit") || has("@angular")) return 4200;
  if (has("next") || has("react-scripts") || has("nuxt")) return DEFAULT_NODE_PREVIEW_PORT;
  return DEFAULT_NODE_PREVIEW_PORT;
}

async function detectStatic(workspacePath: string): Promise<RuntimeStrategy | null> {
  if (!(await fileExists(path.join(workspacePath, "index.html")))) return null;
  const port = Number(process.env.ANCHORAGE_RUNTIME_PORT) || 8080;
  return {
    kind: "static",
    startCommand: `python3 -m http.server ${port}`,
    port,
    url: `http://localhost:${port}`,
  };
}

// ── Start + readiness ─────────────────────────────────────────────────────────

interface StartResult {
  ok: true;
  previewUrl: string;
}
interface StartFailure {
  ok: false;
  error: string;
}

async function startStrategy(
  task: TaskEnvelope,
  strategy: RuntimeStrategy,
  workspacePath: string,
): Promise<StartResult | StartFailure> {
  const url = strategy.url ?? (strategy.port ? `http://localhost:${strategy.port}` : null);
  if (!url) {
    return { ok: false, error: "strategy has no resolvable preview URL/port to probe" };
  }

  // Node projects need their dependencies installed before the dev server runs.
  if (strategy.kind === "node") {
    const pm = strategy.startCommand.split(" ")[0] ?? "npm";
    const install = await runToCompletion(task, `${pm} install`, workspacePath, INSTALL_TIMEOUT_MS);
    if (!install.ok) {
      return { ok: false, error: `dependency install failed: ${install.error}` };
    }
    const cleanup = await cleanStaleNodeBuildOutput(task, workspacePath, strategy);
    if (!cleanup.ok) return cleanup;
  }

  const logPath = await runtimeLogPath(task);

  if (strategy.port) await freePreviewPort(task, strategy.port);

  emit(task, "tool.requested", "info", `Starting solution: ${strategy.startCommand}`, {
    tool: "shell.exec",
    input: { command: strategy.startCommand, cwd: workspacePath },
  });

  if (strategy.kind === "docker-compose") {
    // `up -d` returns once containers are created; await it, then probe.
    const up = await runToCompletion(task, strategy.startCommand, workspacePath, 600_000);
    if (!up.ok) return { ok: false, error: up.error };
  } else {
    // Long-running dev/static server: spawn detached so it survives this agent.
    const failure = startDetached(strategy.startCommand, workspacePath, logPath, strategy.port);
    if (failure) return { ok: false, error: failure };
  }

  const timeout = READY_TIMEOUT_MS[strategy.kind] ?? 90_000;
  emit(task, "agent.progress", "info", `Waiting for ${url} to become reachable`, {
    url,
    timeoutMs: timeout,
  });
  const ready = await waitForUrl(url, timeout);
  if (!ready) {
    await teardown(strategy, workspacePath);
    const tail = await readLogTail(logPath);
    return {
      ok: false,
      error: `preview did not respond at ${url} within ${Math.round(timeout / 1000)}s${
        tail ? `\n--- last runtime log lines ---\n${tail}` : ""
      }`,
    };
  }

  emit(task, "tool.result", "info", "Solution is reachable", {
    tool: "shell.exec",
    success: true,
    output: { url },
  });
  return { ok: true, previewUrl: url };
}

async function cleanStaleNodeBuildOutput(
  task: TaskEnvelope,
  workspacePath: string,
  strategy: RuntimeStrategy,
): Promise<{ ok: true } | StartFailure> {
  if (!(await isNextProject(workspacePath)) || !usesDevStart(strategy.startCommand))
    return { ok: true };

  const nextDir = path.join(workspacePath, ".next");
  if (!(await fileExists(nextDir))) return { ok: true };

  emit(task, "tool.requested", "info", "Removing stale Next.js build output before dev preview", {
    tool: "workspace.cleanup",
    input: { path: ".next", reason: "next dev preview must not reuse stale sandbox build output" },
  });

  try {
    await fs.rm(nextDir, { force: true, recursive: true });
  } catch (error) {
    return {
      ok: false,
      error: `failed to remove stale .next directory: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  emit(task, "tool.result", "info", "Removed stale Next.js build output", {
    tool: "workspace.cleanup",
    success: true,
    output: { path: ".next" },
  });
  return { ok: true };
}

async function runtimeLogPath(task: TaskEnvelope): Promise<string> {
  const logRoot =
    process.env.ANCHORAGE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "anchorage-agent-artifacts", task.run.id);
  const dir = path.join(logRoot, "runtime-logs");
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, LOG_FILE);
}

function usesDevStart(command: string): boolean {
  return /\bnext\s+dev\b/.test(command) || /\brun\s+dev\b/.test(command);
}

async function freePreviewPort(task: TaskEnvelope, port: number): Promise<void> {
  emit(task, "tool.requested", "info", "Checking preview port before launch", {
    tool: "shell.exec",
    input: { command: `fuser -k ${port}/tcp || true`, port },
  });

  await new Promise<void>((resolve) => {
    const child = spawn(
      "sh",
      ["-c", `command -v fuser >/dev/null 2>&1 && fuser -k ${port}/tcp || true`],
      { stdio: "ignore" },
    );
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });

  emit(task, "tool.result", "info", "Preview port is ready for launch", {
    tool: "shell.exec",
    success: true,
    output: { port },
  });
}

/** Spawn a detached, unref'd process group so the server outlives the agent. */
function startDetached(
  command: string,
  cwd: string,
  logPath: string,
  port?: number,
): string | null {
  try {
    const out = openSync(logPath, "a");
    const child = spawn("sh", ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", out, out],
      env: {
        ...process.env,
        ...(port ? { PORT: String(port) } : {}),
        // Bind to all interfaces, not 127.0.0.1. When the agent runs inside a
        // container (the orchestrator worker), a server bound to localhost is
        // unreachable from the host even with a published port — the port
        // forward lands on the container's external interface. HOST/HOSTNAME
        // cover Next.js, and most node servers honor one of these.
        HOST: "0.0.0.0",
        HOSTNAME: "0.0.0.0",
      },
    });
    child.unref();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

interface RunOk {
  ok: true;
}
interface RunErr {
  ok: false;
  error: string;
}

/** Run a command to completion (awaited), bounded by a timeout. */
async function runToCompletion(
  task: TaskEnvelope,
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<RunOk | RunErr> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ ok: false, error: `command timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true });
      } else {
        const detail = Buffer.concat(stderr).toString("utf8").slice(-2000).trim();
        resolve({ ok: false, error: `exit ${code}${detail ? `: ${detail}` : ""}` });
      }
    });
    void task;
  });
}

/** Poll an HTTP URL until it responds (any status) or the deadline passes. */
async function waitForUrl(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeOnce(url)) return true;
    await delay(READY_POLL_MS);
  }
  return false;
}

function probeOnce(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 3_000 }, (res) => {
      res.resume();
      // A 5xx means the server is listening but the app is erroring (e.g.
      // `next start` with no prior build → required-server-files.json missing).
      // That is NOT a usable preview, so don't report it as healthy — only
      // 2xx/3xx/4xx count as ready. Otherwise a broken app (or a stale process
      // still bound to the port) gets surfaced to the user as "running".
      const code = res.statusCode ?? 0;
      resolve(code > 0 && code < 500);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function teardown(strategy: RuntimeStrategy, workspacePath: string): Promise<void> {
  if (!strategy.stopCommand) return;
  await new Promise<void>((resolve) => {
    const child = spawn("sh", ["-c", strategy.stopCommand as string], {
      cwd: workspacePath,
      stdio: "ignore",
    });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

async function readLogTail(logPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(logPath, "utf8");
    return raw.slice(-1500).trim();
  } catch {
    return "";
  }
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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

async function currentBranch(workspacePath: string): Promise<string | null> {
  const result = await runGit(workspacePath, ["symbolic-ref", "--short", "HEAD"]);
  const branch = result.stdout.trim();
  return result.exitCode === 0 && branch ? branch : null;
}

async function pushCurrentBranch(
  task: TaskEnvelope,
  workspacePath: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const originResult = await runGit(workspacePath, ["remote", "get-url", "origin"]);
  const origin = originResult.stdout.trim();
  if (originResult.exitCode !== 0 || !origin) return { ok: false, reason: "no origin remote" };

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const pushTarget = authenticatedPushUrl(origin, token);
  if (!pushTarget) return { ok: false, reason: "unsupported remote or missing GitHub token" };

  emit(task, "tool.requested", "info", "Pushing runtime guide commit", {
    tool: "git.push",
    input: { branch, remote: redactUrl(origin) },
  });

  const push = await runGit(workspacePath, ["push", pushTarget, `${branch}:${branch}`]);
  if (push.exitCode !== 0) return { ok: false, reason: redactToken(gitMessage(push), token) };
  return { ok: true };
}

function authenticatedPushUrl(origin: string, token: string | undefined): string | null {
  if (!token) return null;
  const httpsOrigin = githubHttpsOrigin(origin);
  if (!httpsOrigin) return null;
  const withoutCreds = httpsOrigin.replace(/^https:\/\/([^@/]*@)?/, "");
  return `https://x-access-token:${token}@${withoutCreds}`;
}

function githubHttpsOrigin(origin: string): string | null {
  if (origin.startsWith("https://")) return origin;
  const sshMatch = /^git@github\.com:([^/]+)\/(.+)$/.exec(origin);
  if (!sshMatch) return null;
  const [, owner, repo] = sshMatch;
  return `https://github.com/${owner}/${repo}`;
}

function redactUrl(url: string): string {
  return url.replace(/\/\/[^@/]*@/, "//");
}

function redactToken(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.split(token).join("***");
}

function gitMessage(result: CommandResult): string {
  return result.stderr.trim() || result.stdout.trim() || `git failed (exit ${result.exitCode})`;
}

function emitGitWarning(task: TaskEnvelope, tool: string, code: string, message: string): void {
  emit(task, "tool.result", "warn", "Runtime guide git operation did not complete", {
    tool,
    success: false,
    output: { error: { code, message } },
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Task / IO helpers (mirrors the other agents) ──────────────────────────────

function parseTask(
  rawTask: string,
): { ok: true; value: TaskEnvelope } | { ok: false; exitCode: number } {
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

async function writeArtifact(task: TaskEnvelope, preview: RuntimePreview) {
  const artifactRoot =
    process.env.ANCHORAGE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "anchorage-agent-artifacts", task.run.id);
  await fs.mkdir(artifactRoot, { recursive: true });
  const artifactPath = path.join(artifactRoot, "runtime-preview.json");
  const content = `${JSON.stringify(preview, null, 2)}\n`;
  await fs.writeFile(artifactPath, content, "utf8");
  return {
    artifactType: RUNTIME_PREVIEW_ARTIFACT_TYPE,
    uri: `file://${artifactPath}`,
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(content),
  };
}

function fail(task: TaskEnvelope, code: string, message: string, exitCode: number): number {
  emit(task, "agent.failed", "error", message, { error: { code, message } });
  return exitCode;
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

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
