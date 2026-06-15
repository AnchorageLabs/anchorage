// repo_map — an opt-in, on-demand structural overview of the workspace, ranked
// by import in-degree (how many other files import a file). In-degree is the
// dominant term of PageRank on a sparse import graph, so this is a cheap,
// reliable proxy for "the files everything depends on" — the same signal aider's
// repo map and slurp surface, exposed the way anchorage already exposes
// structural intelligence: as a tool the model CHOOSES to call, never injected
// into the prompt. It saves tokens by replacing a flurry of list_dir / grep /
// read_file orientation probes with one ranked map, and it is purely additive:
// if the model ignores it, nothing changes; the ranking is a heuristic hint the
// model still verifies by reading. Fails closed (a short note) on any error.

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { grammarForPath, outlineFile } from "../symbols/engine.js";
import type { JsonObject, ToolContext, ToolDefinition, ToolHandlerResult } from "../types.js";
import { repoParamSchema, resolveRepoRoot } from "./context-repos.js";

const MAX_FILES_SCANNED = 3000;
const MAX_BYTES_PER_FILE = 256_000;
const DEFAULT_RESULTS = 40;
const MAX_RESULTS = 150;
const MAX_OUTLINE_FILES = 25; // only outline the top results (tree-sitter cost)
const MAX_SYMBOLS_PER_FILE = 6;
const GIT_TIMEOUT_MS = 15_000;

function gitListFiles(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const out: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      resolve(
        Buffer.concat(out)
          .toString("utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0),
      );
    });
  });
}

// Basename of a file without its source extension: "tools/budget.ts" → "budget".
function fileToken(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  return base.replace(/\.(m|c)?[jt]sx?$|\.(py|go|rs|rb|java|kt|php|cs)$/i, "");
}

// The imported module's final segment: "./tools/budget.js" → "budget",
// "@anchorage/agent-llm" → "agent-llm", python "pkg.mod.sub" → "sub".
function moduleToken(spec: string): string {
  let s = spec.trim();
  if (s.includes("/")) s = s.slice(s.lastIndexOf("/") + 1);
  else if (s.includes(".")) s = s.slice(s.lastIndexOf(".") + 1);
  return s.replace(/\.(m|c)?[jt]sx?$/i, "");
}

// Linear, backtracking-safe regexes. Applied per-language so a JS `import x`
// (local binding) is never mistaken for a Python module import.
const JS_FROM = /\bfrom\s*['"]([^'"]+)['"]/g;
const JS_CALL = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const JS_BARE = /^\s*import\s*['"]([^'"]+)['"]/gm;
const PY_FROM = /^\s*from\s+([\w.]+)\s+import\b/gm;
const PY_IMPORT = /^\s*import\s+([\w.]+)/gm;

function importSpecifiers(relPath: string, code: string): string[] {
  const ext = path.extname(relPath).toLowerCase();
  const specs: string[] = [];
  const collect = (re: RegExp) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(code);
    while (m !== null) {
      if (m[1]) specs.push(m[1]);
      m = re.exec(code);
    }
  };
  if (ext === ".py") {
    collect(PY_FROM);
    collect(PY_IMPORT);
  } else {
    // JS/TS family and anything else that uses from/import/require syntax.
    collect(JS_FROM);
    collect(JS_CALL);
    collect(JS_BARE);
  }
  return specs;
}

interface RankedFile {
  path: string;
  language: string;
  inDegree: number;
}

async function repoMapHandler(input: JsonObject, ctx: ToolContext): Promise<ToolHandlerResult> {
  const repoRes = resolveRepoRoot(input, ctx);
  if (!repoRes.ok) return { ok: false, code: "unknown_repo", message: repoRes.message };
  const root = repoRes.root;

  const limit =
    typeof input.max_results === "number" && input.max_results > 0
      ? Math.min(Math.floor(input.max_results), MAX_RESULTS)
      : DEFAULT_RESULTS;

  const failClosed = (msg: string): ToolHandlerResult => ({
    ok: true,
    output: `repo_map unavailable: ${msg} Use list_dir / grep / find_references instead.`,
    bytesOut: msg.length,
    meta: { repo_map: false },
  });

  const allFiles = await gitListFiles(root);
  if (allFiles === null) return failClosed("git ls-files failed (not a git repo?).");

  // Source files only (a known grammar = a file with import structure worth
  // ranking). Bounded so a huge monorepo can't blow up a single call.
  const sourceFiles = allFiles
    .filter((f) => grammarForPath(f) !== null)
    .slice(0, MAX_FILES_SCANNED);
  if (sourceFiles.length === 0) return failClosed("no recognized source files in the index.");

  // token → set of files that import it (distinct importers = in-degree).
  const importers = new Map<string, Set<string>>();
  for (const rel of sourceFiles) {
    const abs = path.join(root, rel);
    const st = await stat(abs).catch(() => null);
    if (!st?.isFile() || st.size > MAX_BYTES_PER_FILE) continue;
    const code = await readFile(abs, "utf8").catch(() => null);
    if (code === null) continue;
    const seenThisFile = new Set<string>();
    for (const spec of importSpecifiers(rel, code)) {
      const tok = moduleToken(spec);
      if (tok.length === 0 || seenThisFile.has(tok)) continue;
      seenThisFile.add(tok);
      let set = importers.get(tok);
      if (!set) {
        set = new Set();
        importers.set(tok, set);
      }
      set.add(rel);
    }
  }

  const ranked: RankedFile[] = sourceFiles
    .map((rel) => ({
      path: rel,
      language: grammarForPath(rel) ?? "?",
      inDegree: importers.get(fileToken(rel))?.size ?? 0,
    }))
    .sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path))
    .slice(0, limit);

  // Outline the top files so each map entry shows a few exported symbols — the
  // detail that makes the map actionable. Bounded + fail-closed per file.
  const lines: string[] = [
    `=== repo_map: ${sourceFiles.length} source files, top ${ranked.length} by import in-degree ===`,
    "(in-degree = how many files import this one; a heuristic centrality hint — verify by reading)",
  ];
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    if (!r) continue;
    let symbolNote = "";
    if (i < MAX_OUTLINE_FILES) {
      const defs = await outlineFile(path.join(root, r.path)).catch(() => null);
      if (defs && defs.length > 0) {
        const names = defs.slice(0, MAX_SYMBOLS_PER_FILE).map((d) => d.name);
        symbolNote = `  — ${names.join(", ")}${defs.length > names.length ? ", …" : ""}`;
      }
    }
    lines.push(`  [${r.inDegree}] ${r.path} (${r.language})${symbolNote}`);
  }

  const text = lines.join("\n");
  return {
    ok: true,
    output: text,
    bytesOut: text.length,
    meta: {
      repo_map: true,
      sourceFiles: sourceFiles.length,
      ranked: ranked.length,
      repo: repoRes.ref,
    },
  };
}

export const repoMapTool: ToolDefinition = {
  name: "repo_map",
  description:
    "Ranked structural overview of the repository: the source files most depended on (highest " +
    "import in-degree) with a few of each file's top-level symbols. Call this ONCE for orientation " +
    "at the start of a task — to find the core modules and entry points before reading — instead of " +
    "many list_dir / grep probes. The ranking is a heuristic centrality hint (import-counted, not " +
    "type-resolved); confirm specifics by reading the files. Fails closed to a short note when the " +
    "index can't be built.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: MAX_RESULTS,
        description: `How many top-ranked files to return (default ${DEFAULT_RESULTS}).`,
      },
      repo: repoParamSchema,
    },
  },
  capability: "repo.read",
  handler: repoMapHandler,
};
