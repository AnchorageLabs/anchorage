// Frontend toolchain detection for the isolated component preview.
//
// The isolated preview renders the changed components in a throwaway Vite app
// (never booting the real product), so it needs to know just enough about the
// repo to build a faithful harness: which framework, the language, the package
// manager, the app root, where to install deps, the global stylesheets to pull
// in for fidelity, and whether Tailwind is in play.
//
// Crucially, detection is REPO-AGNOSTIC. The frontend may live anywhere — at the
// repo root, or in a subdirectory of a monorepo (apps/web, packages/ui, …). We
// find the app by walking UP from each changed component to the nearest
// package.json that declares a known UI framework, and fall back to scanning the
// tree when a changed file has no framework package above it. Whatever framework
// we recognize routes to its deterministic Vite template; anything we don't is
// handled by the LLM general path in the caller.

import fs from "node:fs/promises";
import path from "node:path";

// Frameworks with a deterministic Vite template. Anything outside this set is
// left to the LLM general path (the caller passes the detected/likely framework
// as a hint). React/Preact share a template; the rest have their own.
export type FrontendFramework = "react" | "preact" | "vue" | "svelte" | "solid";
export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

export interface FrontendToolchain {
  framework: FrontendFramework;
  language: "ts" | "js";
  packageManager: PackageManager;
  /** Absolute path to the frontend app root — the dir whose package.json declares the framework. */
  appRoot: string;
  /** Absolute path to install deps at: the workspace/monorepo root when one exists, else appRoot. */
  installRoot: string;
  /** App-root-relative global stylesheets to import into the harness for fidelity. */
  globalCss: string[];
  hasTailwind: boolean;
  /** App-root-relative tsconfig path, when present (used for alias resolution). */
  tsconfigPath: string | null;
}

// Common global stylesheet locations, in rough priority order. Whichever exist
// are imported into the harness so the preview inherits the app's base styles
// (resets, fonts, Tailwind directives, CSS variables).
const GLOBAL_CSS_CANDIDATES = [
  "src/index.css",
  "src/main.css",
  "src/global.css",
  "src/globals.css",
  "src/styles/globals.css",
  "src/styles/global.css",
  "src/styles/index.css",
  "src/app/globals.css",
  "app/globals.css",
  "styles/globals.css",
  "src/App.css",
  "index.css",
];

const TAILWIND_CONFIG_CANDIDATES = [
  "tailwind.config.js",
  "tailwind.config.cjs",
  "tailwind.config.mjs",
  "tailwind.config.ts",
];

// Directories we never descend into when scanning for an app root — they hold
// dependencies or build output, not source we'd preview.
const SCAN_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  "coverage",
  ".cache",
  "out",
  ".anchorage",
]);
const SCAN_MAX_DEPTH = 5;

async function readPackageJson(dir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function allDeps(pkg: Record<string, unknown>): Record<string, unknown> {
  return {
    ...((pkg.dependencies as Record<string, unknown>) ?? {}),
    ...((pkg.devDependencies as Record<string, unknown>) ?? {}),
    ...((pkg.peerDependencies as Record<string, unknown>) ?? {}),
  };
}

async function fileExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

/**
 * Classify the framework a package.json declares, most-specific first. Returns
 * null when no recognized UI framework is present (the caller falls back).
 */
function frameworkOfDeps(deps: Record<string, unknown>): FrontendFramework | null {
  const has = (name: string) => Object.hasOwn(deps, name);
  // React first (most common), then the others. Preact only when React is absent
  // so a react+preact/compat setup still reads as React.
  if (has("react") && has("react-dom")) return "react";
  if (has("vue")) return "vue";
  if (has("svelte")) return "svelte";
  if (has("solid-js")) return "solid";
  if (has("preact")) return "preact";
  return null;
}

/** The framework declared by the package.json at `dir`, or null. */
async function frameworkAt(dir: string): Promise<FrontendFramework | null> {
  const pkg = await readPackageJson(dir);
  if (!pkg) return null;
  return frameworkOfDeps(allDeps(pkg));
}

/** Whether a dir is a workspace/monorepo root (deps install from here). */
async function isWorkspaceRoot(dir: string): Promise<boolean> {
  if (await fileExists(path.join(dir, "pnpm-workspace.yaml"))) return true;
  const pkg = await readPackageJson(dir);
  if (!pkg) return false;
  // npm/yarn/bun workspaces: a `workspaces` array (or {packages:[]}) on the root.
  return Object.hasOwn(pkg, "workspaces");
}

/** Whether a dir carries a package-manager lockfile. */
async function hasLockfile(dir: string): Promise<boolean> {
  return (
    (await fileExists(path.join(dir, "pnpm-lock.yaml"))) ||
    (await fileExists(path.join(dir, "yarn.lock"))) ||
    (await fileExists(path.join(dir, "bun.lockb"))) ||
    (await fileExists(path.join(dir, "bun.lock"))) ||
    (await fileExists(path.join(dir, "package-lock.json"))) ||
    (await fileExists(path.join(dir, "npm-shrinkwrap.json")))
  );
}

/** Ancestor dirs of `start`, from `start` up to and including `stop` (a prefix). */
function ancestorsWithin(start: string, stop: string): string[] {
  const chain: string[] = [];
  let dir = path.resolve(start);
  const top = path.resolve(stop);
  // Guard against `start` not being under `stop`.
  if (!dir.startsWith(top)) return [top];
  while (true) {
    chain.push(dir);
    if (dir === top) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chain;
}

async function detectPackageManagerAt(
  appRoot: string,
  workspacePath: string,
): Promise<PackageManager> {
  // Lockfiles live at the install root, which may be an ancestor of appRoot.
  for (const dir of ancestorsWithin(appRoot, workspacePath)) {
    if (await fileExists(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
    if (await fileExists(path.join(dir, "yarn.lock"))) return "yarn";
    if (
      (await fileExists(path.join(dir, "bun.lockb"))) ||
      (await fileExists(path.join(dir, "bun.lock")))
    )
      return "bun";
    if (await fileExists(path.join(dir, "package-lock.json"))) return "npm";
  }
  return "npm";
}

/**
 * The directory to run `install` in so the app's deps (and the framework runtime
 * the harness aliases) end up resolvable. In a workspace, that's the highest
 * workspace/lockfile root at or above the app; otherwise the app root itself.
 */
async function resolveInstallRoot(appRoot: string, workspacePath: string): Promise<string> {
  let installRoot = appRoot;
  // Walk from app root up to the worktree root; the highest workspace marker or
  // lockfile wins (monorepos install everything from the top).
  for (const dir of ancestorsWithin(appRoot, workspacePath)) {
    if ((await isWorkspaceRoot(dir)) || (await hasLockfile(dir))) installRoot = dir;
  }
  return installRoot;
}

async function detectGlobalCss(appRoot: string): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of GLOBAL_CSS_CANDIDATES) {
    if (await fileExists(path.join(appRoot, candidate))) found.push(candidate);
  }
  return found;
}

async function detectTailwind(
  appRoot: string,
  workspacePath: string,
  deps: Record<string, unknown>,
): Promise<boolean> {
  if (Object.hasOwn(deps, "tailwindcss")) return true;
  // Tailwind config may sit at the app root or a workspace root above it.
  for (const dir of ancestorsWithin(appRoot, workspacePath)) {
    for (const candidate of TAILWIND_CONFIG_CANDIDATES) {
      if (await fileExists(path.join(dir, candidate))) return true;
    }
  }
  return false;
}

/** Build the full toolchain for a known app root. */
async function buildToolchain(
  appRoot: string,
  framework: FrontendFramework,
  workspacePath: string,
): Promise<FrontendToolchain> {
  const pkg = (await readPackageJson(appRoot)) ?? {};
  const deps = allDeps(pkg);
  const tsconfigPath = (await fileExists(path.join(appRoot, "tsconfig.json")))
    ? "tsconfig.json"
    : null;
  const language: "ts" | "js" = tsconfigPath || Object.hasOwn(deps, "typescript") ? "ts" : "js";

  return {
    framework,
    language,
    packageManager: await detectPackageManagerAt(appRoot, workspacePath),
    appRoot,
    installRoot: await resolveInstallRoot(appRoot, workspacePath),
    globalCss: await detectGlobalCss(appRoot),
    hasTailwind: await detectTailwind(appRoot, workspacePath, deps),
    tsconfigPath,
  };
}

/**
 * Detect the frontend toolchain at a SINGLE directory (no walk-up). Returns null
 * when that dir's package.json declares no recognized framework. Kept for the
 * simple "the repo root is the app" case and for direct unit testing; the
 * monorepo-aware entry point is `resolveFrontendToolchain`.
 */
export async function detectFrontendToolchain(
  workspacePath: string,
): Promise<FrontendToolchain | null> {
  const framework = await frameworkAt(workspacePath);
  if (!framework) return null;
  return buildToolchain(workspacePath, framework, workspacePath);
}

/** Walk up from `startDir` to the worktree root; return the nearest app root. */
async function nearestAppRoot(
  startDir: string,
  workspacePath: string,
): Promise<{ appRoot: string; framework: FrontendFramework } | null> {
  for (const dir of ancestorsWithin(startDir, workspacePath)) {
    const framework = await frameworkAt(dir);
    if (framework) return { appRoot: dir, framework };
  }
  return null;
}

/** Breadth-first scan for the shallowest app root under the worktree. */
async function scanForAppRoot(
  workspacePath: string,
): Promise<{ appRoot: string; framework: FrontendFramework } | null> {
  let frontier = [{ dir: workspacePath, depth: 0 }];
  while (frontier.length > 0) {
    const next: typeof frontier = [];
    // Check every dir at this depth before descending — shallower roots win.
    for (const { dir } of frontier) {
      const framework = await frameworkAt(dir);
      if (framework) return { appRoot: dir, framework };
    }
    for (const { dir, depth } of frontier) {
      if (depth >= SCAN_MAX_DEPTH) continue;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || SCAN_IGNORE.has(entry.name) || entry.name.startsWith("."))
          continue;
        next.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * Resolve the frontend toolchain for an isolated preview, REGARDLESS of repo
 * layout. Strategy:
 *   1. Walk up from each changed component to the nearest package.json that
 *      declares a UI framework, tallying which app root owns the most changed
 *      components (ties broken by the shallowest root).
 *   2. If no changed component sits under a framework package, scan the tree for
 *      the shallowest app root.
 * Returns null only when the repo declares no recognized framework anywhere we
 * looked — in which case the caller leaves it to the LLM general path.
 */
export async function resolveFrontendToolchain(
  workspacePath: string,
  changedComponentAbsPaths: string[],
): Promise<FrontendToolchain | null> {
  const root = path.resolve(workspacePath);

  // 1) Vote by changed-component ownership.
  const votes = new Map<string, { framework: FrontendFramework; count: number; depth: number }>();
  for (const abs of changedComponentAbsPaths) {
    const found = await nearestAppRoot(path.dirname(path.resolve(abs)), root);
    if (!found) continue;
    const existing = votes.get(found.appRoot);
    if (existing) existing.count += 1;
    else
      votes.set(found.appRoot, {
        framework: found.framework,
        count: 1,
        depth: ancestorsWithin(found.appRoot, root).length,
      });
  }
  const ranked = [...votes.entries()].sort(
    ([, a], [, b]) => b.count - a.count || a.depth - b.depth,
  );
  const winner = ranked[0];
  if (winner) {
    const [appRoot, info] = winner;
    return buildToolchain(appRoot, info.framework, root);
  }

  // 2) Fall back to scanning the tree.
  const scanned = await scanForAppRoot(root);
  if (scanned) return buildToolchain(scanned.appRoot, scanned.framework, root);

  return null;
}

/**
 * Resolve the absolute directory of a package as installed for `appRoot`,
 * walking up through workspace/hoisted `node_modules`. Returns null when it
 * isn't installed anywhere on the chain (the harness then relies on Vite's own
 * resolution). Used to pin the framework runtime to a single copy.
 */
export async function resolvePackageDir(
  appRoot: string,
  workspacePath: string,
  pkgName: string,
): Promise<string | null> {
  for (const dir of ancestorsWithin(appRoot, path.resolve(workspacePath))) {
    const candidate = path.join(dir, "node_modules", pkgName);
    if (await fileExists(path.join(candidate, "package.json"))) return candidate;
  }
  return null;
}

// ── App build-config bridging (alias + PostCSS) ───────────────────────────────
// The harness must resolve the app's imports/styles WITHOUT inheriting the app's
// config files by accident (those reference deps the isolated harness lacks).
// These read the app's declarations so the harness can bridge them explicitly,
// for any framework / alias scheme / PostCSS plugin set.

export interface AliasEntry {
  /** Import prefix the app uses, e.g. "@" or "@components". */
  find: string;
  /** Absolute path it resolves to. */
  replacement: string;
}

// Strip // and /* */ comments and trailing commas so a JSONC tsconfig parses.
function parseJsonc(text: string): unknown {
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const noTrailingCommas = noComments.replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(noTrailingCommas);
  } catch {
    return null;
  }
}

const POSTCSS_CONFIG_FILES = [
  "postcss.config.js",
  "postcss.config.cjs",
  "postcss.config.mjs",
  "postcss.config.ts",
  "postcss.config.json",
  ".postcssrc",
  ".postcssrc.js",
  ".postcssrc.cjs",
  ".postcssrc.json",
];

/**
 * The nearest directory (appRoot up to the install root) that holds a PostCSS
 * config, or one declared via a package.json "postcss" key — the dir to point
 * Vite's `css.postcss` at so the app's real pipeline runs. Null when none, so
 * the caller isolates PostCSS instead.
 */
export async function findPostcssConfigDir(
  appRoot: string,
  workspacePath: string,
): Promise<string | null> {
  for (const dir of ancestorsWithin(appRoot, path.resolve(workspacePath))) {
    for (const name of POSTCSS_CONFIG_FILES) {
      if (await fileExists(path.join(dir, name))) return dir;
    }
    const pkg = await readPackageJson(dir);
    if (pkg && Object.hasOwn(pkg, "postcss")) return dir;
  }
  return null;
}

/**
 * Read the app's module aliases from its tsconfig `compilerOptions.paths`
 * (+ baseUrl), following one `extends` level, and translate them to absolute
 * Vite aliases. Returns [] when there's no tsconfig or no paths — so the harness
 * resolves `@/`, `~/`, `@components/`, etc. for ANY app's alias scheme rather
 * than a single hard-coded `@`. Best-effort: malformed tsconfig → [].
 */
export async function readTsconfigAliases(
  appRoot: string,
  _workspacePath: string,
): Promise<AliasEntry[]> {
  const tsconfigPath = path.join(appRoot, "tsconfig.json");
  const collected = await loadTsconfigCompilerOptions(tsconfigPath, 0);
  if (!collected) return [];
  const { baseUrl, paths } = collected;
  if (!paths) return [];
  const base = path.resolve(appRoot, baseUrl ?? ".");
  const entries: AliasEntry[] = [];
  for (const [key, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || targets.length === 0) continue;
    const target = targets[0];
    if (typeof target !== "string") continue;
    const find = key.replace(/\/\*$/, "");
    const rel = target.replace(/\/\*$/, "");
    if (!find) continue;
    entries.push({ find, replacement: path.resolve(base, rel) });
  }
  return entries;
}

interface TsCompilerOptions {
  baseUrl?: string;
  paths?: Record<string, unknown>;
}

async function loadTsconfigCompilerOptions(
  tsconfigPath: string,
  depth: number,
): Promise<TsCompilerOptions | null> {
  if (depth > 3) return null;
  let raw: string;
  try {
    raw = await fs.readFile(tsconfigPath, "utf8");
  } catch {
    return null;
  }
  const parsed = parseJsonc(raw) as Record<string, unknown> | null;
  if (!parsed) return null;
  const co = (parsed.compilerOptions as Record<string, unknown> | undefined) ?? {};
  const baseUrl = typeof co.baseUrl === "string" ? co.baseUrl : undefined;
  const paths =
    co.paths && typeof co.paths === "object" ? (co.paths as Record<string, unknown>) : undefined;

  // Follow `extends` (one relative level at a time) for inherited baseUrl/paths.
  if ((!baseUrl || !paths) && typeof parsed.extends === "string") {
    const extPath = parsed.extends.startsWith(".")
      ? path.resolve(path.dirname(tsconfigPath), parsed.extends)
      : null; // package-name extends are not resolved (best-effort)
    if (extPath) {
      const file = extPath.endsWith(".json") ? extPath : `${extPath}.json`;
      const inherited = await loadTsconfigCompilerOptions(file, depth + 1);
      if (inherited) {
        // baseUrl in the EXTENDING file is relative to that file's dir; an
        // inherited baseUrl stays relative to the base file's dir. We resolve
        // both against their own dirs by returning the child's when present.
        return {
          baseUrl: baseUrl ?? inherited.baseUrl,
          paths: paths ?? inherited.paths,
        };
      }
    }
  }
  return { baseUrl, paths };
}
