// Repo facts layer — cartographer's .anchorage/repo-context.json injected as a
// system-prompt block, so reasoning agents (planner, coder, reviewer) start
// every run already knowing the repo's stack, commands, entry points, and
// contracts instead of spending their first tool turns on ls/grep/package.json
// orientation. Before reading, the artifact is refreshed with `cartographer
// scan`: the scan is fingerprint-cached (same git tree → no-op), so the doc is
// kept up to date with every run at near-zero cost. Everything fails closed —
// no binary, a crash, or a malformed artifact yields an empty block and the
// agent orients itself with the regular discovery tools.

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { cartographerCommand } from "./cartographer.js";

// Warm scans are a fingerprint check (milliseconds); the timeout covers a cold
// first scan of a large tree. On timeout we still try to read whatever artifact
// already exists on disk.
const SCAN_TIMEOUT_MS = 30_000;

const MAX_ENTRY_POINTS = 12;
const MAX_LIST_ITEMS = 10;
const MAX_BLOCK_CHARS = 4_000;

function repoContextEnabled(env: Record<string, string>): boolean {
  const raw = env.ANCHORAGE_REPO_CONTEXT_ENABLED;
  if (raw === undefined) return true; // on by default; a missing binary still fails closed
  return !/^(false|0|no|off)$/i.test(raw.trim());
}

function spawnCartographer(
  args: string[],
  root: string,
  env: Record<string, string>,
): Promise<void> {
  const { cmd, baseArgs } = cartographerCommand(env);
  return new Promise((resolve) => {
    const child = spawn(cmd, [...baseArgs, ...args], {
      cwd: root,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, SCAN_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function runScan(root: string, env: Record<string, string>): Promise<void> {
  return spawnCartographer(["scan", root], root, env);
}

/** Run `cartographer map` only when architecture.json is absent. Zero-token (deterministic). */
function runMapIfMissing(root: string, env: Record<string, string>): Promise<void> {
  if (existsSync(join(root, ".anchorage", "architecture.json"))) return Promise.resolve();
  return spawnCartographer(["map", root], root, env);
}

type Json = { [key: string]: Json } | Json[] | boolean | null | number | string;

function isObject(value: unknown): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: Json | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function strList(value: Json | undefined, cap = MAX_LIST_ITEMS): string[] {
  if (!Array.isArray(value)) return [];
  const items = value.filter((v): v is string => typeof v === "string");
  return items.length > cap ? [...items.slice(0, cap), `+${items.length - cap} more`] : items;
}

/**
 * Directories (root + up to two levels) that already have a `node_modules`,
 * relative to the workspace (root → "."). The orchestrator's preinstall/artifact
 * cache populates these OFF the agent loop, before the agent starts — so the
 * agent has no other way to know deps are ready, and would otherwise burn turns
 * running (and, on a missing git-hook binary, RETRYING) `yarn install`. We
 * surface this so the prompt can tell it not to. Mirrors the preinstall target
 * walk (depth ≤2, skip node_modules/.git/dotdirs). Best-effort/sync: any error
 * yields [] and the agent just installs as before.
 */
export function installedDepDirs(workspacePath: string, maxDepth = 2): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (existsSync(join(dir, "node_modules"))) {
      out.push(relative(workspacePath, dir) || ".");
    }
    if (depth >= maxDepth) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === "node_modules" || e.name === ".git" || e.name.startsWith(".")) continue;
      walk(join(dir, e.name), depth + 1);
    }
  };
  try {
    walk(workspacePath, 0);
  } catch {
    return [];
  }
  return out;
}

function formatDigest(context: { [key: string]: Json }, depsInstalledDirs: string[] = []): string {
  const lines: string[] = [];

  const repo = isObject(context.repo) ? context.repo : {};
  const arch = isObject(context.architecture) ? context.architecture : {};
  const repoBits = [
    str(repo.primaryLanguage),
    str(repo.packageManager),
    str(repo.runtime),
    str(arch.pattern),
  ].filter((v): v is string => v !== null);
  lines.push(
    `repo: ${str(repo.name) ?? "(unnamed)"} — ${repoBits.join(", ") || "(unknown stack)"}`,
  );
  const layers = strList(arch.layers);
  if (layers.length > 0) lines.push(`layers: ${layers.join(", ")}`);
  const patterns = strList(repo.workspacePatterns);
  if (patterns.length > 0) lines.push(`workspace packages: ${patterns.join(", ")}`);

  // Detection-gap warnings demote a null command from "checked, absent" to
  // "unknown — verify yourself". Asserting absence the scanner couldn't prove
  // is how a Go monorepo shipped a non-compiling PR: cmd:test->none told the
  // gate there was nothing to run.
  const warnings = strList(context.warnings, 6);
  const gapKeys = new Set(
    warnings
      .map((w) => w.match(/treat cmd:(\w+) as UNKNOWN/)?.[1])
      .filter((k): k is string => k !== undefined),
  );
  const commands = isObject(context.commands) ? context.commands : {};
  const depsInstalled = depsInstalledDirs.length > 0;
  const commandLines: string[] = [];
  let hasGaps = false;
  for (const key of ["install", "build", "typecheck", "lint", "format", "test", "check"]) {
    const value = commands[key];
    if (key === "install" && depsInstalled) {
      // Deps are ALREADY installed (orchestrator preinstall / artifact cache, off
      // the agent loop). Re-running install is redundant and, on this image, can
      // wedge — so neutralize the one line the agent keys off, whether or not a
      // command was detected.
      const cmd = typeof value === "string" ? `${value} ` : "";
      commandLines.push(
        `  install: ${cmd}— ALREADY DONE; node_modules present in ${depsInstalledDirs.join(", ")}. Do NOT run install.`,
      );
    } else if (typeof value === "string") commandLines.push(`  ${key}: ${value}`);
    else if (gapKeys.has(key)) {
      commandLines.push(`  ${key}: UNKNOWN — detection gap; find and run it yourself`);
      hasGaps = true;
    } else if (value === null) commandLines.push(`  ${key}: (none — checked, absent)`);
  }
  if (commandLines.length > 0) {
    lines.push(
      hasGaps
        ? "commands (detected where bound; UNKNOWN entries MUST be discovered and verified):"
        : "commands (authoritative — use these to verify, do not rediscover):",
    );
    lines.push(...commandLines);
  }
  if (warnings.length > 0) {
    lines.push("scanner warnings (facts above may be incomplete):");
    for (const warning of warnings) lines.push(`  - ${warning}`);
  }

  const entryPoints = Array.isArray(context.entryPoints) ? context.entryPoints : [];
  if (entryPoints.length > 0) {
    lines.push(`entry points (${entryPoints.length}):`);
    for (const entry of entryPoints.slice(0, MAX_ENTRY_POINTS)) {
      if (!isObject(entry)) continue;
      const taskTypes = strList(entry.taskTypes, 4);
      const suffix = taskTypes.length > 0 ? ` [${taskTypes.join(", ")}]` : "";
      lines.push(
        `  ${str(entry.id) ?? "?"} (${str(entry.kind) ?? "?"}) ${str(entry.path) ?? ""}${suffix}`,
      );
    }
    if (entryPoints.length > MAX_ENTRY_POINTS) {
      lines.push(`  +${entryPoints.length - MAX_ENTRY_POINTS} more`);
    }
  }

  const contracts = isObject(context.agentContracts) ? context.agentContracts : {};
  const contractBits: string[] = [];
  for (const key of ["agentsMd", "soulMd", "claudeConfig"]) {
    const value = str(contracts[key]);
    if (value) contractBits.push(value);
  }
  const hooks = strList(contracts.gitHooks);
  if (hooks.length > 0) {
    const policy = str(contracts.hookPolicy);
    contractBits.push(`git hooks: ${hooks.join(", ")}${policy ? ` (${policy})` : ""}`);
  }
  if (contractBits.length > 0) lines.push(`agent contracts: ${contractBits.join("; ")}`);

  const environment = isObject(context.environment) ? context.environment : {};
  const envVars = strList(environment.requiredEnvVars);
  if (envVars.length > 0) lines.push(`required env vars (names only): ${envVars.join(", ")}`);

  const infra = isObject(context.infra) ? context.infra : {};
  const ci = isObject(infra.ci) ? infra.ci : {};
  const ciProvider = str(ci.provider);
  if (ciProvider) {
    const workflows = strList(ci.workflows, 6);
    lines.push(`ci: ${ciProvider}${workflows.length > 0 ? ` (${workflows.join(", ")})` : ""}`);
  }

  return lines.join("\n");
}

/**
 * Build the repo-facts system-prompt block for a mounted workspace. Refreshes
 * .anchorage/repo-context.json via `cartographer scan` (fingerprint-cached
 * no-op when the tree is unchanged), then renders a compact digest. Returns ""
 * when disabled, the binary is unavailable and no artifact exists, or the
 * artifact is malformed — the agent then falls back to live discovery.
 */
export async function repoContextPromptBlock(
  workspacePath: string,
  env: Record<string, string>,
): Promise<string> {
  if (!repoContextEnabled(env)) return "";

  await runScan(workspacePath, env);
  await runMapIfMissing(workspacePath, env);

  let parsed: unknown;
  try {
    const raw = await readFile(join(workspacePath, ".anchorage", "repo-context.json"), "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return "";
  }
  if (!isObject(parsed)) return "";

  const depsInstalledDirs = installedDepDirs(workspacePath);

  let digest: string;
  try {
    digest = formatDigest(parsed, depsInstalledDirs);
  } catch {
    return "";
  }
  if (digest.length === 0) return "";
  if (digest.length > MAX_BLOCK_CHARS) {
    digest = `${digest.slice(0, MAX_BLOCK_CHARS)}\n  …(truncated)`;
  }

  // When deps are already installed (orchestrator preinstall / artifact cache,
  // off the agent loop), state it up front and unambiguously — the agent can't
  // observe that work otherwise and would waste turns (and, on a missing
  // hook binary, RETRY) running install.
  const depsLine =
    depsInstalledDirs.length > 0
      ? [
          "",
          `DEPENDENCIES ALREADY INSTALLED — node_modules is present and ready in: ${depsInstalledDirs.join(", ")}.`,
          "Do NOT run install (yarn/npm/pnpm/bun install) for these; it is redundant. Build/test/lint directly.",
        ]
      : [];

  return [
    "",
    "REPO CONTEXT (pre-computed by cartographer):",
    digest,
    "Bound facts (those with values) are verified against the current tree — do NOT spend",
    "tool calls rediscovering them. '(none — checked, absent)' means checked and absent.",
    "'UNKNOWN' or any scanner warning means detection could not see that area: treat it as",
    "unverified, discover it yourself, and NEVER skip a build/test step because it is",
    "UNKNOWN here. For anything not listed, inspect the repo as usual.",
    ...depsLine,
  ].join("\n");
}
