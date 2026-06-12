// Cartographer-backed tools — `impact` and `tests_for`. They ride the same
// `repo.read` surface as the per-call symbol tools, but answer from the
// PERSISTED index that cartographer maintains at .anchorage/index/symbols.db
// (delta-refreshed by content hash on every call), so they see the whole-repo
// dependency graph — barrel re-exports and sibling workspace packages included
// — instead of scanning candidate files one by one. Everything fails closed:
// no cartographer binary, a crash, or malformed output yields a short note and
// the model falls back to find_references / grep with no failure path.

import { spawn } from "node:child_process";
import type { JsonObject, ToolContext, ToolDefinition, ToolHandlerResult } from "../types.js";
import { repoParamSchema, resolveRepoRoot } from "./context-repos.js";

// A cold first call may build the index for the whole repo; warm calls are
// hash checks + SQL (milliseconds). The timeout covers the cold case.
const CARTOGRAPHER_TIMEOUT_MS = 90_000;

const MAX_DEFINITIONS = 10;
const MAX_REFERENCE_FILES = 25;
const MAX_LINES_PER_FILE = 8;
const MAX_DEPENDENTS = 25;
const MAX_TESTS = 15;

const FALLBACK_NOTE =
  "Cartographer index unavailable (binary missing or query failed). " +
  "Use find_references / grep instead.";

function failClosed(message: string): ToolHandlerResult {
  return { ok: true, output: message, bytesOut: message.length, meta: { cartographer: false } };
}

function cartographerEnabled(env: Record<string, string>): boolean {
  const raw = env.ANCHORAGE_TOOL_CARTOGRAPHER_ENABLED;
  if (raw === undefined) return true; // on by default; absence of the binary still fails closed
  return !/^(false|0|no|off)$/i.test(raw.trim());
}

// ANCHORAGE_CARTOGRAPHER_BIN points at the CLI (a .js entry runs under node);
// unset falls back to `cartographer` on PATH. A spawn error fails closed, so
// an unconfigured environment simply doesn't offer index answers.
export function cartographerCommand(
  env: Record<string, string>,
): { cmd: string; baseArgs: string[] } {
  const bin = env.ANCHORAGE_CARTOGRAPHER_BIN?.trim();
  if (bin && bin.length > 0) {
    return bin.endsWith(".js") ? { cmd: "node", baseArgs: [bin] } : { cmd: bin, baseArgs: [] };
  }
  return { cmd: "cartographer", baseArgs: [] };
}

function runCartographer(
  root: string,
  env: Record<string, string>,
  args: string[],
): Promise<string | null> {
  const { cmd, baseArgs } = cartographerCommand(env);
  return new Promise((resolve) => {
    const child = spawn(cmd, [...baseArgs, ...args, ".", "--json"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const out: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, CARTOGRAPHER_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      resolve(Buffer.concat(out).toString("utf8"));
    });
  });
}

function isValidSymbol(symbol: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol);
}

// ── impact ────────────────────────────────────────────────────────────────────

interface ImpactJson {
  definitions?: { file?: string; name?: string; kind?: string; line?: number }[];
  references?: { file?: string; lines?: number[]; isTest?: boolean }[];
  dependents?: string[];
  tests?: string[];
  truncated?: boolean;
}

async function impactHandler(input: JsonObject, ctx: ToolContext): Promise<ToolHandlerResult> {
  if (!cartographerEnabled(ctx.env)) return failClosed(FALLBACK_NOTE);

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

  const raw = await runCartographer(repoRes.root, ctx.env, ["impact", symbol]);
  if (raw === null) return failClosed(FALLBACK_NOTE);
  let parsed: ImpactJson;
  try {
    parsed = JSON.parse(raw) as ImpactJson;
  } catch {
    return failClosed(FALLBACK_NOTE);
  }

  const definitions = parsed.definitions ?? [];
  const references = parsed.references ?? [];
  const dependents = parsed.dependents ?? [];
  const tests = parsed.tests ?? [];
  if (definitions.length === 0 && references.length === 0) {
    return failClosed(`No occurrences of '${symbol}' in the index. ${FALLBACK_NOTE}`);
  }

  const lines: string[] = [`=== impact: ${symbol} ===`];
  lines.push(`definition${definitions.length === 1 ? "" : "s"}:`);
  if (definitions.length === 0) lines.push("  (none — references only)");
  for (const def of definitions.slice(0, MAX_DEFINITIONS)) {
    lines.push(`  ${def.file}:${def.line}  ${def.kind ?? ""} ${def.name ?? ""}`.trimEnd());
  }
  lines.push(`referencing files (${references.length}):`);
  for (const ref of references.slice(0, MAX_REFERENCE_FILES)) {
    const shown = (ref.lines ?? []).slice(0, MAX_LINES_PER_FILE).join(",");
    const more = (ref.lines ?? []).length > MAX_LINES_PER_FILE ? ",…" : "";
    lines.push(`  ${ref.file}:${shown}${more}${ref.isTest ? "  (test)" : ""}`);
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
  if (parsed.truncated) {
    lines.push("[truncated: common identifier — prefer a more specific exported name]");
  }

  const text = lines.join("\n");
  return {
    ok: true,
    output: text,
    bytesOut: text.length,
    meta: {
      cartographer: true,
      symbol,
      definitions: definitions.length,
      referenceFiles: references.length,
      dependents: dependents.length,
      tests: tests.length,
      truncated: parsed.truncated === true,
    },
  };
}

export const impactTool: ToolDefinition = {
  name: "impact",
  description:
    "PREFER THIS over find_references when deciding WHERE a change lands or WHAT it can break. " +
    "Returns the full blast radius of a symbol from cartographer's persisted whole-repo index: " +
    "definition site(s), every referencing file with line numbers, the files that import a " +
    "defining file (transitive — crosses barrel re-exports and workspace package boundaries, " +
    "which per-file scans miss), and the test files covering them. ALWAYS call this before " +
    "changing an exported function/class/type signature, and cite the dependents when reviewing " +
    "such a change. Syntactic (identifier-matched, not type-resolved); 'symbol' must be a single " +
    "identifier. If the index is unavailable it returns a short note; only then fall back to " +
    "find_references.",
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
  if (!cartographerEnabled(ctx.env)) return failClosed(FALLBACK_NOTE);

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

  const raw = await runCartographer(repoRes.root, ctx.env, ["tests-for", file]);
  if (raw === null) return failClosed(FALLBACK_NOTE);
  let tests: unknown;
  try {
    tests = JSON.parse(raw);
  } catch {
    return failClosed(FALLBACK_NOTE);
  }
  if (!Array.isArray(tests)) return failClosed(FALLBACK_NOTE);
  const list = tests.filter((t): t is string => typeof t === "string");

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
    meta: { cartographer: true, path: file, tests: list.length },
  };
}

export const testsForTool: ToolDefinition = {
  name: "tests_for",
  description:
    "Which test files cover a given source file, from cartographer's persisted index: tests that " +
    "import it (directly or through the reverse-import closure) plus name-mirrored tests " +
    "(foo.ts → foo.test.ts). Call this after editing a file to pick the tests worth running, and " +
    "when reviewing to check whether a changed file has any covering tests at all. If the index " +
    "is unavailable it returns a short note; only then infer tests from naming conventions.",
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
