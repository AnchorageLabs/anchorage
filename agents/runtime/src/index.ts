#!/usr/bin/env node
import { spawn } from "node:child_process";
import { openSync, readFileSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ToolEvent } from "@anchorage/agent-llm";
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
import { classifyChange, skipReason } from "./classify.js";
import {
  buildHarnessFiles,
  buildStoryFor,
  componentExtensionsFor,
  hasTemplate,
  RENDER_PROBE_PATH,
  runtimePackageName,
  STORIES_DIR,
} from "./harness.js";
import { generateHarnessWithLlm, resolveRuntimeLlmConfig } from "./llm-harness.js";
import {
  PREVIEW_MANIFEST_FILE,
  type PreviewManifest,
  parsePreviewManifest,
  serializePreviewManifest,
} from "./manifest.js";
import { publicPreviewUrl } from "./preview-url.js";
import { type ComponentEntry, isRenderableComponent } from "./stories.js";
import {
  type FrontendToolchain,
  findPostcssConfigDir,
  readTsconfigAliases,
  resolveFrontendToolchain,
  resolvePackageDir,
} from "./toolchain.js";

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

  // ── Is there anything VISUAL to preview? ─────────────────────────────────────
  // The runtime gate is intentionally optional and scoped to visual/frontend
  // changes — the kind a human wants to *see* before merge. Anything else skips
  // the gate cleanly instead of trying to boot the app:
  //   - docs        → nothing to run.
  //   - backend     → needs the app's real services/secrets (DB, auth, external
  //                   APIs) we don't have here, so it can never come up — don't
  //                   try and fail (the teramot-aleph case).
  //   - non-visual  → config/tooling only; nothing to look at.
  // When there's no change artifact we can't classify, so we fall through and
  // attempt a run as before.
  const changedFiles = await changedFilesFromArtifacts(task.value);
  if (changedFiles && changedFiles.length > 0) {
    const kind = classifyChange(changedFiles);
    if (kind !== "visual") {
      return finishNotApplicable(task.value, skipReason(kind, changedFiles));
    }

    // Visual change: render the changed components in isolation (a throwaway
    // harness with mock data) so a real product never has to boot with secrets it
    // doesn't have here. We NEVER boot the real app for a visual change — on any
    // skip/failure we skip the gate cleanly (the PR still opens). On by default;
    // with ANCHORAGE_RUNTIME_ISOLATED=0 we keep the legacy app-boot behavior below.
    if (isolatedPreviewEnabled()) {
      const isolated = await runIsolatedPreview(task.value, workspacePath, changedFiles);
      if ("ok" in isolated && isolated.ok) {
        const unrendered = isolated.unrendered;
        const rendered = isolated.componentCount - unrendered.length;
        // Flag un-renderable cards LOUDLY instead of passing off an error card as
        // a healthy preview: the PR still opens, but those components are called
        // out as UNVERIFIED rather than silently looking fine.
        const summary = unrendered.length
          ? `Rendered ${rendered} of ${isolated.componentCount} changed component(s) in isolation at ${isolated.previewUrl}. ${unrendered.length} could not be previewed (needs app context/props): ${unrendered
              .map((u) => u.name)
              .join(", ")} — the PR opens, but those are UNVERIFIED by preview.`
          : `Rendering ${isolated.componentCount} changed component(s) in isolation at ${isolated.previewUrl} — the app itself is not running.`;
        const preview = buildRuntimePreview({
          status: "running",
          summary,
          previewUrl: isolated.previewUrl,
          strategy: {
            kind: "isolated",
            startCommand: isolated.manifest.startCommand,
            port: isolated.port,
            url: isolated.localUrl,
          },
        });
        await emitPreview(task.value, preview, unrendered.length ? "warn" : "info");
        emit(
          task.value,
          "agent.completed",
          unrendered.length ? "warn" : "info",
          "runtime started an isolated component preview",
          {
            previewUrl: isolated.previewUrl,
            components: isolated.componentCount,
            ...(unrendered.length ? { unrendered: unrendered.map((u) => u.name) } : {}),
          },
        );
        return ExitCode.Success;
      }
      const reason = "skip" in isolated ? isolated.reason : isolated.error;
      return finishNotApplicable(
        task.value,
        `Could not render this change in isolation (${reason}). Skipping the visual gate — the PR still opens.`,
      );
    }
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
    // The preview is best-effort. A runtime that can't boot HERE (a missing
    // tool/service/secret, a busy port, a build that needs infra we don't have)
    // is an ENVIRONMENT gap, not a reason to fail the change — it must NEVER
    // kill the pipeline. Mirror the tester: degrade to a non-blocking skip and
    // record, out loud, that the change went UNVERIFIED by preview. The PR/merge
    // still proceeds; the user inspects another way.
    const reason = runtimeFailureReason(started.error);
    const preview = buildRuntimePreview({
      status: "not_applicable",
      summary: `Could not start a local preview (${strategy.kind}): ${reason}. Skipping the runtime gate — the change is UNVERIFIED by preview, but the pipeline continues.`,
      strategy,
      ...(strategy.stopCommand ? { stopCommand: strategy.stopCommand } : {}),
      error: started.error,
    });
    await emitPreview(task.value, preview, "warn");
    emit(
      task.value,
      "agent.completed",
      "warn",
      "runtime could not preview in this environment — continuing, change UNVERIFIED",
      { reason: started.error },
    );
    return ExitCode.Success;
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

/**
 * A short, human reason a local preview couldn't start — for the skip message
 * only. Runtime startup failures are ALWAYS non-blocking now (the preview is
 * best-effort), so this never gates; it just makes the "UNVERIFIED" note useful.
 */
function runtimeFailureReason(error: string): string {
  const e = (error ?? "").toLowerCase();
  if (/command not found|: not found|not installed|executable file not found/.test(e))
    return "a required tool is not installed in this environment";
  if (/docker|daemon/.test(e)) return "Docker is not available here";
  if (/eaddrinuse|address already in use|port .*in use/.test(e)) return "the preview port was busy";
  if (/econnrefused|connection refused|could not connect|getaddrinfo|database/.test(e))
    return "it needs a service/database not available here";
  if (/secret|environment variable|missing .*key|unauthorized|\b401\b|\b403\b/.test(e))
    return "it needs secrets/credentials not available here";
  if (/install|enoent|module not found|cannot find module/.test(e))
    return "dependencies could not be prepared";
  if (/timed out|timeout|did not become|health/.test(e)) return "it did not become healthy in time";
  return "the app did not start in this environment";
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

/**
 * Best-effort list of files the change touched, read from the coder's
 * `code.change.result` artifact (prefer an explicit fileDiffs[].path list, fall
 * back to parsing the unified diff). Returns null when no change artifact is
 * available — in that case we do not classify, and attempt a run as before.
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

/**
 * Install command for a package manager with lifecycle scripts DISABLED and
 * devDependencies FORCED ON.
 *
 * Scripts off: a repo's `postinstall`/`prepare` (lefthook/husky git-hook setup,
 * codegen needing infra) are dev tooling that routinely exit non-zero in the
 * worker (e.g. `lefthook: not found` → exit 127) and must not abort the install
 * and thus the whole preview.
 *
 * devDeps on: the orchestrator worker bakes NODE_ENV=production, under which
 * npm/pnpm SKIP devDependencies. But the things a preview needs to build —
 * Vite/build plugins, and crucially the app's PostCSS/Tailwind plugins
 * (`@tailwindcss/postcss`, `autoprefixer`, …) that the harness bridges to — live
 * in devDependencies. Skipping them is exactly why the bridged PostCSS pipeline
 * crashed with "Cannot find module '@tailwindcss/postcss'". Force dev deps on,
 * regardless of NODE_ENV, for every package manager: npm/pnpm honor
 * `--production=false`/`--prod=false`; yarn(classic) honors `--production=false`;
 * bun installs devDeps by default. Unknown flags are ignored by the others we
 * don't pass them to, so each command stays valid.
 */
function installCommand(pm: string): string {
  switch (pm) {
    case "pnpm":
      return "pnpm install --ignore-scripts --prod=false";
    case "yarn":
      return "yarn install --ignore-scripts --production=false";
    case "bun":
      return "bun install --ignore-scripts";
    default:
      return "npm install --ignore-scripts --include=dev --production=false";
  }
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

// ── Isolated component preview ─────────────────────────────────────────────────
// Render the changed components in a throwaway harness (mock data, never the
// app's entry point) so a real product never has to boot with secrets we don't
// have. Hybrid: a deterministic React template (fast, free), an LLM general path
// for any other framework, and a per-repo cache of whatever came up. On by
// default (set ANCHORAGE_RUNTIME_ISOLATED=0 to opt out); on any failure the gate
// is skipped cleanly — we never fall back to booting the real app.

/** A changed component that came up in the harness but threw on render (e.g. it
 * needs an app context provider or required props it didn't get in isolation). */
interface UnrenderedComponent {
  name: string;
  error: string;
}

interface IsolatedOk {
  ok: true;
  previewUrl: string;
  localUrl: string;
  port: number;
  componentCount: number;
  manifest: PreviewManifest;
  /** Components that could not be rendered in isolation, for a loud "UNVERIFIED"
   * note. Empty when every changed component rendered. */
  unrendered: UnrenderedComponent[];
}
interface IsolatedSkip {
  skip: true;
  reason: string;
}
type IsolatedResult = IsolatedOk | StartFailure | IsolatedSkip;

function isolatedPreviewEnabled(): boolean {
  // On by default. Set ANCHORAGE_RUNTIME_ISOLATED=0 (or false/no/off) to opt out
  // and fall back to the legacy app-boot path.
  const v = process.env.ANCHORAGE_RUNTIME_ISOLATED?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A startup failure caused by the app's PostCSS pipeline — typically a plugin
// the bridged config references that the isolated harness can't resolve
// (e.g. "Cannot find module '@tailwindcss/postcss'", "Loading PostCSS Plugin
// failed"). Such a failure is recoverable: re-scaffold with PostCSS isolated and
// the preview comes up (just less faithfully styled), instead of dying.
function looksLikePostcssFailure(error: string): boolean {
  const e = (error ?? "").toLowerCase();
  return (
    /postcss/.test(e) &&
    /cannot find module|failed to load|loading postcss plugin failed|module not found|cannot resolve/.test(
      e,
    )
  );
}

// Collect the changed, individually-renderable component files + their source.
async function collectComponents(
  workspacePath: string,
  changedFiles: string[],
): Promise<ComponentEntry[]> {
  const components: ComponentEntry[] = [];
  for (const rel of changedFiles) {
    const abs = path.join(workspacePath, rel);
    if (!isRenderableComponent(abs)) continue;
    try {
      components.push({ absPath: abs, source: await fs.readFile(abs, "utf8") });
    } catch {
      // Deleted/renamed/unreadable in the worktree — nothing to render for it.
    }
  }
  return components;
}

// Install the harness's own deps, start its dev server detached, and wait for it
// to answer. Shared by the template, cache, and LLM paths.
async function installStartProbe(
  task: TaskEnvelope,
  harnessDir: string,
  installCommand: string,
  startCommand: string,
  port: number,
): Promise<{ ok: true; localUrl: string } | StartFailure> {
  const install = await runToCompletion(task, installCommand, harnessDir, INSTALL_TIMEOUT_MS);
  if (!install.ok) return { ok: false, error: `harness install failed: ${install.error}` };

  const localUrl = `http://localhost:${port}`;
  await freePreviewPort(task, port);
  const logPath = await runtimeLogPath(task);
  emit(task, "tool.requested", "info", "Starting isolated component harness", {
    tool: "shell.exec",
    input: { command: startCommand, cwd: harnessDir },
  });
  const failure = startDetached(startCommand, harnessDir, logPath, port);
  if (failure) return { ok: false, error: failure };

  const ready = await waitForUrl(localUrl, READY_TIMEOUT_MS.node ?? 90_000);
  if (!ready) {
    const tail = await readLogTail(logPath);
    return {
      ok: false,
      error: `preview did not respond at ${localUrl}${tail ? `\n--- last log lines ---\n${tail}` : ""}`,
    };
  }
  return { ok: true, localUrl };
}

// One card's render outcome, as reported by the harness's SSR render-probe route.
interface CardRenderReport {
  name: string;
  ok: boolean;
  error: string | null;
}

// Poll counts for the render-verification route. The route renders synchronously
// server-side, so it's authoritative on the first successful GET; we retry a few
// times only to ride out the dev server still warming its SSR pipeline.
const RENDER_PROBE_TRIES = 5;
const RENDER_PROBE_POLL_MS = 400;

// Ask the harness which changed components actually rendered. Returns the ones
// that threw (missing provider/props), or [] when there's no signal — a harness
// without the probe (non-React templates, the LLM path) or a verifier that
// couldn't run. "[] = assume rendered" so detection NEVER makes the preview worse
// than before; it can only ADD an escalation/warning when it has a real failure.
async function detectUnrendered(port: number): Promise<UnrenderedComponent[]> {
  const url = `http://localhost:${port}${RENDER_PROBE_PATH}`;
  for (let attempt = 0; attempt < RENDER_PROBE_TRIES; attempt++) {
    const reports = await fetchRenderReports(url);
    if (reports.length > 0) {
      // A name is failed if ANY report for it failed (a late error can follow an
      // initial success).
      const failed = new Map<string, string>();
      for (const r of reports) {
        if (r && r.ok === false && !failed.has(r.name)) {
          failed.set(r.name, r.error ?? "did not render in isolation");
        }
      }
      return [...failed].map(([name, error]) => ({ name, error }));
    }
    await delay(RENDER_PROBE_POLL_MS);
  }
  return [];
}

function fetchRenderReports(url: string): Promise<CardRenderReport[]> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 3_000 }, (res) => {
      if ((res.statusCode ?? 0) >= 400) {
        res.resume();
        resolve([]);
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          resolve(Array.isArray(parsed) ? (parsed as CardRenderReport[]) : []);
        } catch {
          resolve([]);
        }
      });
    });
    req.on("error", () => resolve([]));
    req.on("timeout", () => {
      req.destroy();
      resolve([]);
    });
  });
}

// Write the deterministic framework-template harness (skeleton + no-prop
// stories) for whatever framework the toolchain detected. Renders only the
// components this framework can preview on its own (by file extension).
async function scaffoldTemplate(
  harnessDir: string,
  toolchain: FrontendToolchain,
  components: ComponentEntry[],
  port: number,
  // Whether to bridge the app's REAL PostCSS pipeline (Tailwind etc.) into the
  // harness. On by default for fidelity; the caller turns it OFF to re-scaffold
  // with PostCSS isolated when bridging crashed startup (a plugin the harness
  // can't resolve) — a less-styled preview that comes up beats none.
  bridgePostcss = true,
): Promise<{ ok: true; count: number } | StartFailure> {
  const renderable = new Set(componentExtensionsFor(toolchain.framework));
  const stories = components
    .filter((c) => renderable.has(path.extname(c.absPath).toLowerCase()))
    .map((c) => buildStoryFor(toolchain.framework, c))
    .filter((story): story is NonNullable<typeof story> => story !== null);
  if (stories.length === 0)
    return { ok: false, error: "no detectable component exports to render" };
  // Pin the framework runtime to the app's own copy so state works across the
  // repo/harness module boundary (resolves through hoisted node_modules too).
  const frameworkDir = await resolvePackageDir(
    toolchain.appRoot,
    toolchain.installRoot,
    runtimePackageName(toolchain.framework),
  );
  const reactDomDir =
    toolchain.framework === "react"
      ? await resolvePackageDir(toolchain.appRoot, toolchain.installRoot, "react-dom")
      : null;
  // Bridge the app's build config into the harness WITHOUT inheriting its files:
  // its module aliases (any scheme, from tsconfig paths) and its real PostCSS
  // pipeline (any plugins, from the app's own config + installed deps).
  const aliasEntries = await readTsconfigAliases(toolchain.appRoot, toolchain.installRoot);
  const postcssConfigDir = bridgePostcss
    ? await findPostcssConfigDir(toolchain.appRoot, toolchain.installRoot)
    : null;
  try {
    await fs.rm(harnessDir, { recursive: true, force: true });
    for (const file of buildHarnessFiles({
      toolchain,
      port,
      frameworkDir,
      reactDomDir,
      aliasEntries,
      postcssConfigDir,
    })) {
      const dest = path.join(harnessDir, file.path);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, file.content, "utf8");
    }
    const storiesAbs = path.join(harnessDir, STORIES_DIR);
    await fs.mkdir(storiesAbs, { recursive: true });
    for (const story of stories) {
      await fs.writeFile(path.join(storiesAbs, story.fileName), story.content, "utf8");
    }
  } catch (error) {
    return { ok: false, error: `failed to scaffold template harness: ${errMessage(error)}` };
  }
  return { ok: true, count: stories.length };
}

async function readManifest(workspacePath: string): Promise<PreviewManifest | null> {
  try {
    const raw = await fs.readFile(
      path.join(workspacePath, ANCHORAGE_DIR, PREVIEW_MANIFEST_FILE),
      "utf8",
    );
    return parsePreviewManifest(raw);
  } catch {
    return null;
  }
}

async function writeManifest(workspacePath: string, manifest: PreviewManifest): Promise<void> {
  try {
    await fs.mkdir(path.join(workspacePath, ANCHORAGE_DIR), { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, ANCHORAGE_DIR, PREVIEW_MANIFEST_FILE),
      serializePreviewManifest(manifest),
      "utf8",
    );
  } catch {
    // Non-fatal: a read-only workspace just means no cache speed-up next time.
  }
}

async function runIsolatedPreview(
  task: TaskEnvelope,
  workspacePath: string,
  changedFiles: string[],
): Promise<IsolatedResult> {
  const components = await collectComponents(workspacePath, changedFiles);
  if (components.length === 0) {
    return { skip: true, reason: "no renderable component files in the change" };
  }

  const port = Number(process.env.ANCHORAGE_RUNTIME_PORT) || DEFAULT_NODE_PREVIEW_PORT;

  // Find the frontend app REGARDLESS of repo layout: walk up from the changed
  // components to the nearest framework package (handles monorepos with the app
  // in a subdirectory), falling back to a tree scan. `appRoot` is where the
  // harness lives and what the LLM inspects; `installRoot` is where deps install
  // (a workspace/monorepo root when one exists).
  const toolchain = await resolveFrontendToolchain(
    workspacePath,
    components.map((c) => c.absPath),
  );
  const appRoot = toolchain?.appRoot ?? workspacePath;
  const installRoot = toolchain?.installRoot ?? workspacePath;
  const harnessDir = path.join(appRoot, ANCHORAGE_DIR, "preview");
  const harnessRelDir = path.posix.join(ANCHORAGE_DIR, "preview");

  if (toolchain) {
    emit(task, "agent.progress", "info", `Detected ${toolchain.framework} app`, {
      framework: toolchain.framework,
      appRoot,
      installRoot,
      monorepo: appRoot !== workspacePath,
    });
  }

  // Repo deps must be installed: component imports (and the framework runtime the
  // harness aliases) resolve against the app's own node_modules. In a workspace
  // monorepo this installs from the workspace root so hoisted deps resolve.
  const pm = toolchain?.packageManager ?? (await detectPackageManager(installRoot));
  const repoInstall = await runToCompletion(
    task,
    installCommand(pm),
    installRoot,
    INSTALL_TIMEOUT_MS,
  );
  if (!repoInstall.ok) {
    return { ok: false, error: `repo dependency install failed: ${repoInstall.error}` };
  }

  const ok = (
    manifest: PreviewManifest,
    count: number,
    unrendered: UnrenderedComponent[] = [],
  ): IsolatedOk => {
    const localUrl = `http://localhost:${manifest.port || port}`;
    return {
      ok: true,
      previewUrl: publicPreviewUrl(localUrl),
      localUrl,
      port: manifest.port || port,
      componentCount: count,
      manifest,
      unrendered,
    };
  };

  // Whether escalating to the mock-provider LLM path is even possible. When a
  // template comes up but some cards can't render in isolation (missing
  // providers/props), we hand those to the LLM path — but only if one is
  // configured; otherwise we ship the partial preview and flag the gaps loudly.
  const llmConfigured = !!resolveRuntimeLlmConfig();
  // Render failures the template couldn't satisfy, handed to the LLM path as
  // targeted guidance (which providers/props to mock).
  let templateRenderFailures: UnrenderedComponent[] = [];

  // 1) Cache: reuse a previously-working harness, skipping the LLM. The template
  //    generator re-scaffolds deterministically (picks up this change's
  //    components); the LLM generator reuses the files already on disk.
  const cached = await readManifest(appRoot);
  if (cached) {
    let ready = false;
    if (cached.generator === "template") {
      ready = !!toolchain && (await scaffoldTemplate(harnessDir, toolchain, components, port)).ok;
    } else {
      ready = await fileExists(path.join(harnessDir, "package.json"));
    }
    if (ready) {
      emit(task, "agent.progress", "info", "Reusing cached isolated-preview harness", {
        generator: cached.generator,
        framework: cached.framework,
      });
      const probe = await installStartProbe(
        task,
        harnessDir,
        cached.installCommand,
        cached.startCommand,
        cached.port || port,
      );
      if (probe.ok) {
        const unrendered = await detectUnrendered(cached.port || port);
        // A cached TEMPLATE that still can't render some cards isn't a usable
        // cache hit — regenerate (the LLM path) instead of re-shipping error
        // cards. The LLM cache has no probe, so trust it as before.
        if (cached.generator === "template" && unrendered.length > 0 && llmConfigured) {
          templateRenderFailures = unrendered;
          emit(task, "agent.progress", "info", "Cached template can't render some cards; regenerating", {
            unrendered: unrendered.map((u) => u.name),
          });
        } else {
          return ok(cached, components.length, unrendered);
        }
      } else {
        emit(task, "agent.progress", "warn", "Cached harness no longer works; regenerating", {
          error: probe.error,
        });
      }
    }
  }

  // 2) Fast path: the deterministic framework template (React/Preact/Vue/Svelte/
  //    Solid). If it scaffolds and comes up, we're done — no LLM needed. If it
  //    fails to build/start, we DON'T give up: we fall through to the LLM path
  //    below, which can handle framework quirks the template missed.
  if (toolchain && hasTemplate(toolchain.framework)) {
    const scaffold = await scaffoldTemplate(harnessDir, toolchain, components, port);
    if (scaffold.ok) {
      emit(
        task,
        "agent.progress",
        "info",
        `Scaffolded ${toolchain.framework} preview for ${scaffold.count} component(s)`,
        { harnessDir, framework: toolchain.framework },
      );
      // The harness is a throwaway, self-contained Vite app. Install + run it
      // with npm, NOT the repo's package manager: inside a yarn/pnpm WORKSPACE,
      // `yarn|pnpm install` from a nested non-member dir attaches to the
      // workspace root and never installs the harness's own deps. `--no-workspaces`
      // keeps npm from doing the same when a parent declares workspaces;
      // `--include=dev` + `--production=false` force dev deps in even under
      // NODE_ENV=production (the runtime container sets it). Harness deps live in
      // `dependencies` too, so this is belt-and-suspenders.
      const harnessInstall =
        "npm install --no-workspaces --include=dev --production=false --no-audit --no-fund --loglevel=error";
      const startCommand = "npm run dev";
      let probe = await installStartProbe(task, harnessDir, harnessInstall, startCommand, port);
      let count = scaffold.count;
      // The bridged PostCSS pipeline crashed startup (a plugin the harness can't
      // resolve). Don't give up on the template — re-scaffold with PostCSS
      // isolated and try once more. The preview comes up (less faithfully styled)
      // instead of dying or burning the LLM budget on a problem we understand.
      if (!probe.ok && looksLikePostcssFailure(probe.error)) {
        emit(
          task,
          "agent.progress",
          "warn",
          `${toolchain.framework} template failed on the app's PostCSS config; retrying with PostCSS isolated`,
          { error: probe.error },
        );
        const isolated = await scaffoldTemplate(harnessDir, toolchain, components, port, false);
        if (isolated.ok) {
          const retry = await installStartProbe(task, harnessDir, harnessInstall, startCommand, port);
          if (retry.ok) {
            probe = retry;
            count = isolated.count;
          } else {
            probe.error = retry.error;
          }
        }
      }
      if (probe.ok) {
        const manifest: PreviewManifest = {
          framework: toolchain.framework,
          generator: "template",
          installCommand: harnessInstall,
          startCommand,
          port,
        };
        // Did every changed card actually render, or do some need app context the
        // isolated harness doesn't provide (e.g. <LogtoProvider>, a router)?
        const unrendered = await detectUnrendered(port);
        if (unrendered.length === 0 || !llmConfigured) {
          await writeManifest(appRoot, manifest);
          return ok(manifest, count, unrendered);
        }
        // Hand the un-renderable cards to the mock-provider LLM path, which wraps
        // them in the providers/props they need. Its result is cached, so this
        // costs an LLM pass only the first time a context-dependent component
        // shows up.
        templateRenderFailures = unrendered;
        emit(
          task,
          "agent.progress",
          "info",
          `Template rendered ${count - unrendered.length}/${count} component(s); ${unrendered.length} need app context — building a mock-provider harness`,
          { unrendered: unrendered.map((u) => u.name) },
        );
      } else {
        emit(
          task,
          "agent.progress",
          "warn",
          `${toolchain.framework} template did not come up; falling back to the LLM`,
          { error: probe.error },
        );
      }
    } else {
      emit(task, "agent.progress", "warn", "Template scaffold skipped; trying the LLM", {
        reason: scaffold.error,
      });
    }
  }

  // 3) General path / safety net: the LLM builds a harness for whatever framework
  //    this is (or repairs what the template couldn't bring up). Scoped to the
  //    app root, with the detected framework as a hint, and observable via events.
  const config = resolveRuntimeLlmConfig();
  if (!config) {
    return {
      skip: true,
      reason: toolchain
        ? `the ${toolchain.framework} template did not come up and no LLM is configured for the runtime role`
        : "no template fits this repo and no LLM is configured for the runtime role",
    };
  }
  let previousError: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    emit(
      task,
      "agent.progress",
      "info",
      `Generating isolated preview with the LLM (attempt ${attempt})`,
      {
        components: components.length,
        ...(toolchain ? { framework: toolchain.framework } : {}),
      },
    );
    const gen = await generateHarnessWithLlm(config, {
      task,
      workspacePath: appRoot,
      harnessRelDir,
      components,
      port,
      env: { ...process.env } as Record<string, string>,
      capabilities: new Set(task.capabilities ?? []),
      // Surface the LLM's tool activity as progress so the run is never a silent
      // black box (the old behavior that looked "frozen").
      onEvent: (event) => emitLlmToolEvent(task, event),
      ...(toolchain ? { frameworkHint: toolchain.framework } : {}),
      ...(previousError ? { previousError } : {}),
      // When we escalated from the template because cards threw in isolation,
      // tell the model exactly which components need which providers/props.
      ...(templateRenderFailures.length > 0 ? { renderFailures: templateRenderFailures } : {}),
    });
    if (!gen.ok) {
      previousError = gen.error;
      emit(task, "agent.progress", "warn", `LLM harness attempt ${attempt} failed`, {
        error: gen.error,
      });
      continue;
    }
    const probe = await installStartProbe(
      task,
      harnessDir,
      gen.installCommand,
      gen.startCommand,
      port,
    );
    if (probe.ok) {
      const manifest: PreviewManifest = {
        framework: gen.framework,
        generator: "llm",
        installCommand: gen.installCommand,
        startCommand: gen.startCommand,
        port,
      };
      await writeManifest(appRoot, manifest);
      // The LLM harness has no SSR probe route, so this is [] (we trust the
      // model wired the providers/props it was told to). For a React harness it
      // built that happens to expose the route, any remaining gaps still surface.
      const unrendered = await detectUnrendered(port);
      return ok(manifest, components.length, unrendered);
    }
    previousError = probe.error;
  }
  return { ok: false, error: `LLM preview did not come up: ${previousError ?? "unknown error"}` };
}

// Bridge the LLM tool-loop's structured events into runtime progress events, so
// the harness-generation phase is visible instead of looking frozen. Kept terse:
// one progress line per tool call with a bounded payload.
function emitLlmToolEvent(task: TaskEnvelope, event: ToolEvent): void {
  if (event.kind === "tool.requested") {
    emit(task, "agent.progress", "info", `LLM · ${event.tool}`, {
      tool: event.tool,
      turn: event.turn,
    });
  }
}

async function startStrategy(
  task: TaskEnvelope,
  strategy: RuntimeStrategy,
  workspacePath: string,
): Promise<StartResult | StartFailure> {
  // localUrl is what the agent itself connects to (readiness probing); the
  // reported URL is what flows back to the orchestrator's previewUrl field and
  // may be overridden with a publicly reachable address.
  const localUrl = strategy.url ?? (strategy.port ? `http://localhost:${strategy.port}` : null);
  if (!localUrl) {
    return { ok: false, error: "strategy has no resolvable preview URL/port to probe" };
  }
  const reportedUrl = publicPreviewUrl(localUrl);

  // Node projects need their dependencies installed before the dev server runs.
  if (strategy.kind === "node") {
    const pm = strategy.startCommand.split(" ")[0] ?? "npm";
    const install = await runToCompletion(
      task,
      installCommand(pm),
      workspacePath,
      INSTALL_TIMEOUT_MS,
    );
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
  emit(task, "agent.progress", "info", `Waiting for ${localUrl} to become reachable`, {
    url: localUrl,
    timeoutMs: timeout,
  });
  const ready = await waitForUrl(localUrl, timeout);
  if (!ready) {
    await teardown(strategy, workspacePath);
    const tail = await readLogTail(logPath);
    return {
      ok: false,
      error: `preview did not respond at ${localUrl} within ${Math.round(timeout / 1000)}s${
        tail ? `\n--- last runtime log lines ---\n${tail}` : ""
      }`,
    };
  }

  emit(task, "tool.result", "info", "Solution is reachable", {
    tool: "shell.exec",
    success: true,
    output: { url: localUrl },
  });
  return { ok: true, previewUrl: reportedUrl };
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
        // The orchestrator worker image bakes NODE_ENV=production for the agent
        // runtime, and a detached dev server inherits it. A dev-start command
        // (e.g. `next dev`) MUST run in development mode: under NODE_ENV=production
        // Next.js does production-only file lookups (.next/required-server-files.json
        // -> ENOENT) and its dev CSS/PostCSS pipeline silently no-ops, so global
        // CSS like `@tailwind` fails to parse and the preview 500s. Force
        // development for dev starts so the previewed app behaves as in local dev.
        ...(usesDevStart(command) ? { NODE_ENV: "development" } : {}),
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
