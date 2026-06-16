// Index-backed tools — `impact` and `tests_for`. They ride the same `repo.read`
// surface as the per-call symbol tools, but answer from the PERSISTED whole-repo
// index (store.ts), so they see the full dependency graph — barrel re-exports and
// sibling workspace packages included — instead of scanning candidate files one
// by one. The index is delta-refreshed by content hash, so a warm call is a hash
// check, not a re-scan. Everything fails closed: when the index can't be built
// the tools return a short note and the model falls back to find_references /
// grep with no failure path.
//
// `cartographerCommand` remains exported for the separate repo-context facts
// layer (repo-context.ts), which still shells out to the cartographer CLI to
// refresh its .anchorage/repo-context.json artifact — a different concern from
// the impact/tests_for blast-radius queries, which are now fully native.

import { getIndexStore } from "../symbols/store.js";
import type { JsonObject, ToolContext, ToolDefinition, ToolHandlerResult } from "../types.js";
import { repoParamSchema, resolveRepoRoot } from "./context-repos.js";

const MAX_DEFINITIONS = 10;
const MAX_REFERENCE_FILES = 25;
const MAX_DEPENDENTS = 25;
const MAX_TESTS = 15;

const FALLBACK_NOTE =
  "Repository index unavailable (not a git repo or build failed). " +
  "Use find_references / grep instead.";

function failClosed(message: string): ToolHandlerResult {
  return { ok: true, output: message, bytesOut: message.length, meta: { index: false } };
}

function indexEnabled(env: Record<string, string>): boolean {
  // Honors the legacy cartographer flag so existing deployment config keeps
  // working; absence of git still fails closed regardless.
  const raw = env.ANCHORAGE_TOOL_CARTOGRAPHER_ENABLED ?? env.ANCHORAGE_TOOL_IMPACT_ENABLED;
  if (raw === undefined) return true;
  return !/^(false|0|no|off)$/i.test(raw.trim());
}

function isValidSymbol(symbol: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol);
}

// `cartographerCommand` is retained for repo-context.ts (the repo-facts layer),
// which refreshes its own artifact via the cartographer CLI. The impact/tests_for
// tools below no longer use it.
export function cartographerCommand(env: Record<string, string>): {
  cmd: string;
  baseArgs: string[];
} {
  const bin = env.ANCHORAGE_CARTOGRAPHER_BIN?.trim();
  if (bin && bin.length > 0) {
    return bin.endsWith(".js") ? { cmd: "node", baseArgs: [bin] } : { cmd: bin, baseArgs: [] };
  }
  return { cmd: "cartographer", baseArgs: [] };
}

// ── impact ────────────────────────────────────────────────────────────────────

async function impactHandler(input: JsonObject, ctx: ToolContext): Promise<ToolHandlerResult> {
  if (!indexEnabled(ctx.env)) return failClosed(FALLBACK_NOTE);

  const symbol = typeof input.symbol === "string" ? input.symbol.trim() : "";
  if (!symbol) {
    return { ok: false, code: "invalid_input", message: "impact requires a 'symbol'." };
  }
  if (!isValidSymbol(symbol)) {
    return {
      ok: false,
      code: "invalid_input",
      message: "impact 'symbol' must be a single identifier. Use grep for patterns.",
    };
  }
  const repoRes = resolveRepoRoot(input, ctx);
  if (!repoRes.ok) return { ok: false, code: "unknown_repo", message: repoRes.message };

  const store = await getIndexStore(repoRes.root);
  if (!store) return failClosed(FALLBACK_NOTE);

  const result = store.impact(symbol);
  const { definitions, references, dependents, tests } = result;
  if (definitions.length === 0 && references.length === 0) {
    return failClosed(`No occurrences of '${symbol}' in the index. ${FALLBACK_NOTE}`);
  }

  const lines: string[] = [`=== impact: ${symbol} ===`];
  lines.push(`definition${definitions.length === 1 ? "" : "s"}:`);
  if (definitions.length === 0) lines.push("  (none — references only)");
  for (const def of definitions.slice(0, MAX_DEFINITIONS)) {
    lines.push(`  ${def.file}:${def.line}  ${def.kind} ${def.name}`.trimEnd());
  }
  lines.push(`referencing files (${references.length}):`);
  for (const ref of references.slice(0, MAX_REFERENCE_FILES)) {
    lines.push(`  ${ref.file}${ref.isTest ? "  (test)" : ""}`);
  }
  if (references.length > MAX_REFERENCE_FILES) lines.push("  …");
  if (dependents.length > 0) {
    lines.push(`dependent files (import a defining file, transitively): ${dependents.length}`);
    for (const dep of dependents.slice(0, MAX_DEPENDENTS)) lines.push(`  ${dep}`);
    if (dependents.length > MAX_DEPENDENTS) lines.push("  …");
  }
  if (tests.length > 0) {
    lines.push("tests to run:");
    for (const test of tests.slice(0, MAX_TESTS)) lines.push(`  ${test}`);
    if (tests.length > MAX_TESTS) lines.push("  …");
  }

  const text = lines.join("\n");
  return {
    ok: true,
    output: text,
    bytesOut: text.length,
    meta: {
      index: true,
      symbol,
      definitions: definitions.length,
      referenceFiles: references.length,
      dependents: dependents.length,
      tests: tests.length,
    },
  };
}

export const impactTool: ToolDefinition = {
  name: "impact",
  description:
    "PREFER THIS over find_references when deciding WHERE a change lands or WHAT it can break. " +
    "Returns the full blast radius of a symbol from the persisted whole-repo index: definition " +
    "site(s), every referencing file, the files that import a defining file (transitive — crosses " +
    "barrel re-exports and workspace package boundaries, which per-file scans miss), and the test " +
    "files covering them. ALWAYS call this before changing an exported function/class/type " +
    "signature, and cite the dependents when reviewing such a change. Syntactic (identifier-" +
    "matched, not type-resolved); 'symbol' must be a single identifier. For exact reference line " +
    "numbers use find_references. If the index is unavailable it returns a short note; only then " +
    "fall back to find_references.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["symbol"],
    properties: {
      symbol: { type: "string", description: "Exact identifier whose blast radius to compute." },
      repo: repoParamSchema,
    },
  },
  capability: "repo.read",
  handler: impactHandler,
};

// ── tests_for ─────────────────────────────────────────────────────────────────

async function testsForHandler(input: JsonObject, ctx: ToolContext): Promise<ToolHandlerResult> {
  if (!indexEnabled(ctx.env)) return failClosed(FALLBACK_NOTE);

  const file = typeof input.path === "string" ? input.path.trim() : "";
  if (!file) {
    return { ok: false, code: "invalid_input", message: "tests_for requires a 'path'." };
  }
  if (file.includes("..")) {
    return {
      ok: false,
      code: "path_outside_workspace",
      message: `Refusing to resolve path outside workspace: ${file}`,
    };
  }
  const repoRes = resolveRepoRoot(input, ctx);
  if (!repoRes.ok) return { ok: false, code: "unknown_repo", message: repoRes.message };

  const store = await getIndexStore(repoRes.root);
  if (!store) return failClosed(FALLBACK_NOTE);

  const list = store.testsFor(file);

  const lines: string[] = [`=== tests_for: ${file} ===`];
  if (list.length === 0) {
    lines.push("  (no test files import this file or mirror its name)");
  }
  for (const test of list.slice(0, MAX_TESTS)) lines.push(`  ${test}`);
  if (list.length > MAX_TESTS) lines.push("  …");

  const text = lines.join("\n");
  return {
    ok: true,
    output: text,
    bytesOut: text.length,
    meta: { index: true, path: file, tests: list.length },
  };
}

export const testsForTool: ToolDefinition = {
  name: "tests_for",
  description:
    "Which test files cover a given source file, from the persisted index: tests that import it " +
    "(directly or through the reverse-import closure) plus name-mirrored tests (foo.ts → " +
    "foo.test.ts). Call this after editing a file to pick the tests worth running, and when " +
    "reviewing to check whether a changed file has any covering tests at all. If the index is " +
    "unavailable it returns a short note; only then infer tests from naming conventions.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", description: "Workspace-relative source file path." },
      repo: repoParamSchema,
    },
  },
  capability: "repo.read",
  handler: testsForHandler,
};

export const cartographerTools: ToolDefinition[] = [impactTool, testsForTool];
