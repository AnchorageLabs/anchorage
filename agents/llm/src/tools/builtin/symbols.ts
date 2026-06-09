// Symbol tools — `find_references` and `symbol_outline`. They sit on the same
// `repo.read` surface as grep/read_file and are offered *alongside* them: the
// model uses whichever fits. They never replace or cap grep. Backed by the
// tree-sitter engine, which fails closed (returns an empty, non-error note) for
// unsupported languages, missing grammars, oversized files, or parse errors —
// so the model simply falls back to grep with no failure path.

import { spawn } from "node:child_process";
import path from "node:path";
import {
  findReferencesInFile,
  grammarForPath,
  outlineFile,
  type SymbolRef,
} from "../symbols/engine.js";
import type { JsonObject, ToolContext, ToolDefinition, ToolHandlerResult } from "../types.js";
import { repoParamSchema, resolveRepoRoot } from "./context-repos.js";

// Candidate-file and result caps keep a single call bounded on large repos.
const MAX_CANDIDATE_FILES = 40;
const MAX_REFERENCES = 80;

// ── Path safety (workspace-sandboxed; mirrors repo.ts) ────────────────────────

interface SafePath {
  absolutePath: string;
  relativePath: string;
}

function resolveInsideWorkspace(workspace: string, requested: string): SafePath | null {
  const normalized = requested.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized) return { absolutePath: workspace, relativePath: "." };
  if (normalized.includes("..")) return null;
  const absolutePath = path.resolve(workspace, normalized);
  const relativePath = path.relative(workspace, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
  return { absolutePath, relativePath: relativePath || "." };
}

// ── git grep -l candidate prefilter ───────────────────────────────────────────

// List git-tracked files containing `symbol` as a whole word. Cheap funnel so
// tree-sitter only parses files that could possibly reference the symbol.
function gitGrepFiles(cwd: string, symbol: string, scope: string | null): Promise<string[]> {
  return new Promise((resolve) => {
    const args = ["grep", "-l", "-I", "-F", "-w", "-e", symbol];
    if (scope && scope !== ".") args.push("--", scope);
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.on("error", () => resolve([]));
    child.on("close", () => {
      const files = Buffer.concat(out)
        .toString("utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      resolve(files);
    });
  });
}

function symbolToolsEnabled(env: Record<string, string>): boolean {
  const raw = env.ANCHORAGE_TOOL_SYMBOLS_ENABLED;
  if (raw === undefined) return true; // on by default; the engine still fails closed
  return !/^(false|0|no|off)$/i.test(raw.trim());
}

const FALLBACK_NOTE =
  "No symbol data available (language unsupported, file too large, or parse failed). " +
  "Use grep + read_file instead.";

function failClosed(message: string): ToolHandlerResult {
  return { ok: true, output: message, bytesOut: message.length, meta: { symbolData: false } };
}

function isValidSymbol(symbol: string): boolean {
  // A single identifier-ish token; keeps git-grep -F -w meaningful and avoids
  // turning this into a regex search (that's what grep is for).
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol);
}

// ── find_references ───────────────────────────────────────────────────────────

async function findReferencesHandler(
  input: JsonObject,
  ctx: ToolContext,
): Promise<ToolHandlerResult> {
  if (!symbolToolsEnabled(ctx.env)) return failClosed(FALLBACK_NOTE);

  const symbol = typeof input.symbol === "string" ? input.symbol.trim() : "";
  if (!symbol) {
    return { ok: false, code: "invalid_input", message: "find_references requires a 'symbol'." };
  }
  if (!isValidSymbol(symbol)) {
    return {
      ok: false,
      code: "invalid_input",
      message: "find_references 'symbol' must be a single identifier. Use grep for patterns.",
    };
  }

  const repoRes = resolveRepoRoot(input, ctx);
  if (!repoRes.ok) return { ok: false, code: "unknown_repo", message: repoRes.message };
  const root = repoRes.root;

  let scope: string | null = null;
  if (typeof input.path === "string" && input.path.trim().length > 0) {
    const safe = resolveInsideWorkspace(root, input.path);
    if (!safe) {
      return {
        ok: false,
        code: "path_outside_workspace",
        message: `Refusing to scan path outside workspace: ${input.path}`,
      };
    }
    scope = safe.relativePath;
  }

  const candidates = (await gitGrepFiles(root, symbol, scope)).filter(
    (file) => grammarForPath(file) !== null,
  );
  if (candidates.length === 0)
    return failClosed(`No references to '${symbol}' found. ${FALLBACK_NOTE}`);

  const scanned = candidates.slice(0, MAX_CANDIDATE_FILES);
  const definitions: SymbolRef[] = [];
  const references: SymbolRef[] = [];
  let parsedAny = false;
  let capped = candidates.length > scanned.length;

  for (const rel of scanned) {
    if (references.length >= MAX_REFERENCES) {
      capped = true;
      break;
    }
    const abs = path.resolve(root, rel);
    const hits = await findReferencesInFile(abs, rel, symbol);
    if (hits === null) continue; // unsupported/parse failure for this file
    parsedAny = true;
    for (const hit of hits) {
      if (hit.isDefinition) definitions.push(hit);
      else if (references.length < MAX_REFERENCES) references.push(hit);
      else capped = true;
    }
  }

  if (!parsedAny) return failClosed(`No symbol data for '${symbol}'. ${FALLBACK_NOTE}`);

  const lines: string[] = [`=== find_references: ${symbol} ===`];
  if (definitions.length > 0) {
    lines.push(`definition${definitions.length > 1 ? "s" : ""}:`);
    for (const def of definitions) lines.push(`  ${def.file}:${def.line}`);
  } else {
    lines.push("definition: (none found in scanned files)");
  }
  lines.push(`references (${references.length}${capped ? "+" : ""}):`);
  if (references.length === 0) lines.push("  (none)");
  for (const ref of references) lines.push(`  ${ref.file}:${ref.line}`);
  lines.push(
    `[scanned ${scanned.length} of ${candidates.length} candidate file(s)${capped ? "; result cap reached" : ""}]`,
  );

  const text = lines.join("\n");
  return {
    ok: true,
    output: text,
    bytesOut: text.length,
    meta: {
      symbolData: true,
      symbol,
      definitions: definitions.length,
      references: references.length,
      filesScanned: scanned.length,
      capped,
    },
  };
}

export const findReferencesTool: ToolDefinition = {
  name: "find_references",
  description:
    "PREFER THIS over grep whenever you need to locate a named symbol. Resolves where a symbol " +
    "(function, class, method, type, variable) is defined and every place it is referenced, " +
    "using tree-sitter — returns the definition site plus exact reference file:line locations. " +
    "ALWAYS call this first when a task asks to change, rename, or review a symbol, or to find " +
    "its callers / blast radius: one call replaces several grep+read_file rounds and won't miss " +
    "call sites the way a substring grep does. Multi-language; syntactic (identifier-matched, " +
    "not type-resolved). 'symbol' must be a single identifier — for free-form patterns use grep. " +
    "If the language is unsupported it returns a short note; only then fall back to grep + read_file.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["symbol"],
    properties: {
      symbol: { type: "string", description: "Exact identifier to resolve." },
      path: {
        type: "string",
        description: "Optional workspace-relative dir/file to limit the scan.",
      },
      repo: repoParamSchema,
    },
  },
  capability: "repo.read",
  handler: findReferencesHandler,
};

// ── symbol_outline ────────────────────────────────────────────────────────────

async function symbolOutlineHandler(
  input: JsonObject,
  ctx: ToolContext,
): Promise<ToolHandlerResult> {
  if (!symbolToolsEnabled(ctx.env)) return failClosed(FALLBACK_NOTE);

  const requestedPath = typeof input.path === "string" ? input.path : "";
  if (!requestedPath) {
    return { ok: false, code: "invalid_input", message: "symbol_outline requires a 'path'." };
  }
  const repoRes = resolveRepoRoot(input, ctx);
  if (!repoRes.ok) return { ok: false, code: "unknown_repo", message: repoRes.message };
  const safe = resolveInsideWorkspace(repoRes.root, requestedPath);
  if (!safe) {
    return {
      ok: false,
      code: "path_outside_workspace",
      message: `Refusing to read path outside workspace: ${requestedPath}`,
    };
  }

  const defs = await outlineFile(safe.absolutePath);
  if (defs === null) {
    return failClosed(`No outline for ${safe.relativePath}. ${FALLBACK_NOTE}`);
  }
  if (defs.length === 0) {
    return failClosed(`No top-level symbols found in ${safe.relativePath}.`);
  }

  const lines: string[] = [`=== symbol_outline: ${safe.relativePath} ===`];
  for (const def of defs) lines.push(`  ${def.kind} ${def.name}  (line ${def.line})`);
  const text = lines.join("\n");
  return {
    ok: true,
    output: text,
    bytesOut: text.length,
    meta: { symbolData: true, path: safe.relativePath, symbols: defs.length },
  };
}

export const symbolOutlineTool: ToolDefinition = {
  name: "symbol_outline",
  description:
    "PREFER THIS over read_file when you only need a file's structure (not its full contents). " +
    "Lists the symbols defined in one file (functions, classes, methods, types, …) with their " +
    "line numbers, using tree-sitter — a fast structural table of contents that orients you and " +
    "points read_file at the exact lines worth opening. Multi-language; if the language is " +
    "unsupported it returns a short note — only then use read_file.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", description: "Workspace-relative file path." },
      repo: repoParamSchema,
    },
  },
  capability: "repo.read",
  handler: symbolOutlineHandler,
};

export const symbolTools: ToolDefinition[] = [findReferencesTool, symbolOutlineTool];
