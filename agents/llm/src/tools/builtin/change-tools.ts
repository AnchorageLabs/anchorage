// Edit-oriented index tools — `locate_change` and `relevant_tests`. Where impact
// answers "what is the full blast radius of this symbol" (definitions + every
// referencing file + transitive dependents), these two answer the two questions
// an agent actually asks while *making* a change:
//
//   locate_change  — "to change X, which files do I open?"  → definition site(s)
//                     plus the files that directly reference X, the concrete edit
//                     targets, ordered defs-first. Narrower and more actionable
//                     than impact's transitive closure.
//   relevant_tests — "I touched these files, what do I run?" → the union of the
//                     covering tests for a set of changed paths, deduped.
//
// Both read from the persisted whole-repo index (store.ts) and fail closed to a
// short note (→ find_references / grep / naming conventions) when it can't build.

import { getIndexStore } from "../symbols/store.js";
import type { JsonObject, ToolContext, ToolDefinition, ToolHandlerResult } from "../types.js";
import { repoParamSchema, resolveRepoRoot } from "./context-repos.js";

const MAX_DEFINITIONS = 10;
const MAX_REFERENCE_FILES = 40;
const MAX_TESTS = 40;
const MAX_INPUT_PATHS = 50;

const FALLBACK_NOTE =
  "Repository index unavailable (not a git repo or build failed). " +
  "Use find_references / grep instead.";

function failClosed(message: string): ToolHandlerResult {
  return { ok: true, output: message, bytesOut: message.length, meta: { index: false } };
}

function isValidSymbol(symbol: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol);
}

// ── locate_change ─────────────────────────────────────────────────────────────

async function locateChangeHandler(
  input: JsonObject,
  ctx: ToolContext,
): Promise<ToolHandlerResult> {
  const symbol = typeof input.symbol === "string" ? input.symbol.trim() : "";
  if (!symbol) {
    return { ok: false, code: "invalid_input", message: "locate_change requires a 'symbol'." };
  }
  if (!isValidSymbol(symbol)) {
    return {
      ok: false,
      code: "invalid_input",
      message: "locate_change 'symbol' must be a single identifier. Use grep for patterns.",
    };
  }
  const repoRes = resolveRepoRoot(input, ctx);
  if (!repoRes.ok) return { ok: false, code: "unknown_repo", message: repoRes.message };

  const store = await getIndexStore(repoRes.root);
  if (!store) return failClosed(FALLBACK_NOTE);

  const definitions = store.definitionsOf(symbol);
  const defFiles = new Set(definitions.map((d) => d.file));
  // Edit targets = the definition files plus the files that directly reference
  // the symbol; the def files lead, callers follow, each listed once.
  const referencing = store.filesReferencing(symbol).filter((f) => !defFiles.has(f));
  if (definitions.length === 0 && referencing.length === 0) {
    return failClosed(`No occurrences of '${symbol}' in the index. ${FALLBACK_NOTE}`);
  }

  const lines: string[] = [`=== locate_change: ${symbol} ===`];
  if (definitions.length > 0) {
    lines.push("defined in:");
    for (const def of definitions.slice(0, MAX_DEFINITIONS)) {
      lines.push(`  ${def.file}:${def.line}  ${def.kind} ${def.name}`.trimEnd());
    }
  } else {
    lines.push("defined in: (no definition found — references only)");
  }
  lines.push(`referenced in (${referencing.length}):`);
  for (const file of referencing.slice(0, MAX_REFERENCE_FILES)) lines.push(`  ${file}`);
  if (referencing.length > MAX_REFERENCE_FILES) lines.push("  …");

  const text = lines.join("\n");
  return {
    ok: true,
    output: text,
    bytesOut: text.length,
    meta: {
      index: true,
      symbol,
      definitions: definitions.length,
      referencingFiles: referencing.length,
    },
  };
}

export const locateChangeTool: ToolDefinition = {
  name: "locate_change",
  description:
    "Given a symbol you intend to change, returns the files to open: its definition site(s) plus " +
    "the files that directly reference it — the concrete edit targets, definitions first. PREFER " +
    "THIS when planning an edit to a named function/class/type/constant; it is narrower and more " +
    "actionable than impact (which also walks the transitive dependent closure for blast radius). " +
    "Syntactic (identifier-matched); 'symbol' must be a single identifier. Fails closed to a short " +
    "note when the index is unavailable.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["symbol"],
    properties: {
      symbol: { type: "string", description: "Exact identifier you plan to change." },
      repo: repoParamSchema,
    },
  },
  capability: "repo.read",
  handler: locateChangeHandler,
};

// ── relevant_tests ────────────────────────────────────────────────────────────

async function relevantTestsHandler(
  input: JsonObject,
  ctx: ToolContext,
): Promise<ToolHandlerResult> {
  const raw = input.paths;
  const paths: string[] = Array.isArray(raw)
    ? raw.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    : typeof input.path === "string"
      ? [input.path]
      : [];
  if (paths.length === 0) {
    return {
      ok: false,
      code: "invalid_input",
      message: "relevant_tests requires 'paths' (an array of changed file paths).",
    };
  }
  if (paths.some((p) => p.includes(".."))) {
    return {
      ok: false,
      code: "path_outside_workspace",
      message: "Refusing to resolve a path outside the workspace.",
    };
  }
  const repoRes = resolveRepoRoot(input, ctx);
  if (!repoRes.ok) return { ok: false, code: "unknown_repo", message: repoRes.message };

  const store = await getIndexStore(repoRes.root);
  if (!store) return failClosed(FALLBACK_NOTE);

  const tests = new Set<string>();
  for (const p of paths.slice(0, MAX_INPUT_PATHS)) {
    for (const t of store.testsFor(p.trim())) tests.add(t);
  }
  const list = [...tests].sort();

  const lines: string[] = [`=== relevant_tests: ${paths.length} changed file(s) ===`];
  if (list.length === 0) {
    lines.push("  (no covering tests found — none import these files or mirror their names)");
  }
  for (const test of list.slice(0, MAX_TESTS)) lines.push(`  ${test}`);
  if (list.length > MAX_TESTS) lines.push("  …");

  const text = lines.join("\n");
  return {
    ok: true,
    output: text,
    bytesOut: text.length,
    meta: { index: true, inputs: paths.length, tests: list.length },
  };
}

export const relevantTestsTool: ToolDefinition = {
  name: "relevant_tests",
  description:
    "Given the set of files you changed, returns the union of test files that cover them — tests " +
    "importing any changed file (directly or through the reverse-import closure) plus name-mirrored " +
    "tests (foo.ts → foo.test.ts), deduped. Call this after editing to pick exactly the tests worth " +
    "running instead of the whole suite. Pass 'paths' as an array of workspace-relative files. " +
    "Fails closed to a short note when the index is unavailable.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["paths"],
    properties: {
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Workspace-relative paths of the changed source files.",
      },
      repo: repoParamSchema,
    },
  },
  capability: "repo.read",
  handler: relevantTestsHandler,
};

export const changeTools: ToolDefinition[] = [locateChangeTool, relevantTestsTool];
