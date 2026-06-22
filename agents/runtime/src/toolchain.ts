// Frontend toolchain detection for the isolated component preview.
//
// The isolated preview renders the changed components in a throwaway Vite app
// (never booting the real product), so it needs to know just enough about the
// repo to build a faithful harness: framework, language, package manager, the
// global stylesheets to pull in for visual fidelity, and whether Tailwind is in
// play. React is the only framework supported in this increment; everything else
// returns null and the caller falls back to the legacy app-boot path.

import fs from "node:fs/promises";
import path from "node:path";

export type FrontendFramework = "react";
export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

export interface FrontendToolchain {
  framework: FrontendFramework;
  language: "ts" | "js";
  packageManager: PackageManager;
  /** Repo-relative global stylesheets to import into the harness for fidelity. */
  globalCss: string[];
  hasTailwind: boolean;
  /** Repo-relative tsconfig path, when present (used for alias resolution). */
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

async function readPackageJson(workspacePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(
      await fs.readFile(path.join(workspacePath, "package.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function allDeps(pkg: Record<string, unknown>): Record<string, unknown> {
  return {
    ...((pkg.dependencies as Record<string, unknown>) ?? {}),
    ...((pkg.devDependencies as Record<string, unknown>) ?? {}),
  };
}

async function fileExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

async function detectPackageManager(workspacePath: string): Promise<PackageManager> {
  if (await fileExists(path.join(workspacePath, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(path.join(workspacePath, "yarn.lock"))) return "yarn";
  if (await fileExists(path.join(workspacePath, "bun.lockb"))) return "bun";
  return "npm";
}

async function detectGlobalCss(workspacePath: string): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of GLOBAL_CSS_CANDIDATES) {
    if (await fileExists(path.join(workspacePath, candidate))) found.push(candidate);
  }
  return found;
}

async function detectTailwind(
  workspacePath: string,
  deps: Record<string, unknown>,
): Promise<boolean> {
  if (Object.hasOwn(deps, "tailwindcss")) return true;
  for (const candidate of TAILWIND_CONFIG_CANDIDATES) {
    if (await fileExists(path.join(workspacePath, candidate))) return true;
  }
  return false;
}

/**
 * Detect the frontend toolchain for the isolated preview. Returns null when the
 * repo isn't a React project (the only framework supported in this increment),
 * so the caller can fall back to the legacy app-boot path.
 */
export async function detectFrontendToolchain(
  workspacePath: string,
): Promise<FrontendToolchain | null> {
  const pkg = await readPackageJson(workspacePath);
  if (!pkg) return null;
  const deps = allDeps(pkg);

  const isReact = Object.hasOwn(deps, "react") && Object.hasOwn(deps, "react-dom");
  if (!isReact) return null;

  const tsconfigPath = (await fileExists(path.join(workspacePath, "tsconfig.json")))
    ? "tsconfig.json"
    : null;
  const language: "ts" | "js" = tsconfigPath || Object.hasOwn(deps, "typescript") ? "ts" : "js";

  return {
    framework: "react",
    language,
    packageManager: await detectPackageManager(workspacePath),
    globalCss: await detectGlobalCss(workspacePath),
    hasTailwind: await detectTailwind(workspacePath, deps),
    tsconfigPath,
  };
}
