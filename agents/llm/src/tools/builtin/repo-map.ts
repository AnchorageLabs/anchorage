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
//
// Backed by the persisted index (store.ts): the ranking and per-file symbol
// outlines are read straight from the whole-repo index — a hash-checked refresh,
// not a fresh scan of every file on every call.

import { getIndexStore } from "../symbols/store.js";
import type { JsonObject, ToolContext, ToolDefinition, ToolHandlerResult } from "../types.js";
import { repoParamSchema, resolveRepoRoot } from "./context-repos.js";

const DEFAULT_RESULTS = 40;
const MAX_RESULTS = 150;
const MAX_OUTLINE_FILES = 25; // only show symbols for the top results
const MAX_SYMBOLS_PER_FILE = 6;

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

  const store = await getIndexStore(root);
  if (!store) return failClosed("repository index unavailable (not a git repo?).");

  const ranking = store.inDegreeRanking();
  if (ranking.length === 0) return failClosed("no recognized source files in the index.");
  const ranked = ranking.slice(0, limit);

  const lines: string[] = [
    `=== repo_map: ${store.fileCount} source files, top ${ranked.length} by import in-degree ===`,
    "(in-degree = how many files import this one; a heuristic centrality hint — verify by reading)",
  ];
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    if (!r) continue;
    let symbolNote = "";
    if (i < MAX_OUTLINE_FILES) {
      const defs = store.outline(r.file);
      if (defs && defs.length > 0) {
        const names = defs.slice(0, MAX_SYMBOLS_PER_FILE).map((d) => d.name);
        symbolNote = `  — ${names.join(", ")}${defs.length > names.length ? ", …" : ""}`;
      }
    }
    lines.push(`  [${r.inDegree}] ${r.file} (${r.lang})${symbolNote}`);
  }

  const text = lines.join("\n");
  return {
    ok: true,
    output: text,
    bytesOut: text.length,
    meta: {
      repo_map: true,
      sourceFiles: store.fileCount,
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
