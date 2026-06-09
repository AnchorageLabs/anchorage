// Cross-repo context: resolve the read tools' optional `repo` argument to a
// root directory, and build the prompt block that tells an agent which
// read-only context repos are mounted. Single source so repo.ts and symbols.ts
// (and the agents) stay consistent.

import type { ContextRepoMount, JsonObject, ToolContext } from "../types.js";

export type RepoRootResolution =
  | { ok: true; root: string; ref: string; isContext: boolean }
  | { ok: false; message: string };

/**
 * Resolve the optional `repo` tool argument to a root directory. Omitted (or
 * empty) → the primary, writable workspace. Set → the matching read-only
 * context mount; an unknown ref fails with the available list so the model can
 * correct itself.
 */
export function resolveRepoRoot(input: JsonObject, ctx: ToolContext): RepoRootResolution {
  const repoRef = typeof input.repo === "string" ? input.repo.trim() : "";
  if (!repoRef) {
    return { ok: true, root: ctx.workspacePath, ref: "(primary)", isContext: false };
  }
  const mounts = ctx.contextRepos ?? [];
  const match = mounts.find((m) => m.ref.toLowerCase() === repoRef.toLowerCase());
  if (!match) {
    const available = mounts.map((m) => m.ref).join(", ") || "(none)";
    return {
      ok: false,
      message: `Unknown context repo '${repoRef}'. Read-only context repos available: ${available}.`,
    };
  }
  return { ok: true, root: match.root, ref: match.ref, isContext: true };
}

/** Budget key for a read, namespaced by context-repo ref to avoid collisions. */
export function repoScopedKey(
  res: { ref: string; isContext: boolean },
  relativePath: string,
): string {
  return res.isContext ? `${res.ref}:${relativePath}` : relativePath;
}

/**
 * Map a task envelope's `contextRepos` (owner/name/root/note) into the tool
 * mounts the loop consumes. Filters out malformed entries; returns [] when none.
 */
export function contextReposFromEnvelope(
  repos: ReadonlyArray<{ owner?: string; name?: string; root?: string; note?: string }> | undefined,
): ContextRepoMount[] {
  if (!repos) return [];
  const mounts: ContextRepoMount[] = [];
  for (const r of repos) {
    if (!r?.owner || !r?.name || !r?.root) continue;
    mounts.push({ ref: `${r.owner}/${r.name}`, root: r.root, ...(r.note ? { note: r.note } : {}) });
  }
  return mounts;
}

/** The JSON-schema property for the optional cross-repo `repo` argument. */
export const repoParamSchema = {
  type: "string",
  description:
    "Optional 'owner/name' of a read-only context repo to read from instead of the primary " +
    "workspace. Omit to read the primary repo — the only one you can write to.",
} as const;

/**
 * Gated system-prompt block describing the mounted read-only context repos.
 * Returns "" when there are none, so single-repo runs get the exact same prompt
 * as before.
 */
export function contextRepoPromptBlock(mounts: ContextRepoMount[] | undefined): string {
  if (!mounts || mounts.length === 0) return "";
  const lines = mounts.map((m) => `  - ${m.ref}${m.note ? ` — ${m.note}` : ""}`);
  return [
    "",
    "CONTEXT REPOSITORIES (read-only):",
    "You have read-only access to additional repositories for reference only:",
    ...lines,
    'Pass the `repo` argument (e.g. repo: "owner/name") to read_file / list_dir / grep /',
    "find_references / symbol_outline to read from them. You CANNOT write to them and MUST",
    "NOT widen the task's scope to them — they exist to inform changes you make in the",
    "primary repo, which is the only repo you commit to. Do not assume their code exists in",
    "the primary repo.",
  ].join("\n");
}
