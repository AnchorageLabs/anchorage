/**
 * Branch naming for a coder run.
 *
 * The planner proposes a branch name from the issue, which means two runs on the
 * same issue propose the SAME name. Since runs execute concurrently and each
 * pushes, a shared name is not a cosmetic problem: the second push either
 * rejects or lands on top of the first run's work. The run id is what
 * disambiguates, so every plan gets run-scoped before it is used.
 *
 * Extracted from `index.ts` for the same reason as `summary.ts` — nothing in
 * that 1,600-line script was exported, so none of this could be tested.
 */

export type JsonValue = JsonObject | JsonValue[] | boolean | null | number | string;
export type JsonObject = { [key: string]: JsonValue };

/** Only the field this module touches; the full plan shape lives in `index.ts`. */
export interface BranchNamed {
  branchName: string;
}

/**
 * A git-safe, bounded tail of the run id.
 *
 * The TAIL rather than the head: run ids share a long common prefix
 * (`run_srv_1781991141437_0`), so the first 12 characters of two different runs
 * are frequently identical — which would defeat the whole point. Twelve
 * characters keeps the branch name readable while staying collision-resistant
 * for the ids this system generates.
 */
export function runIdBranchSuffix(runId: string): string {
  return runId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-12);
}

/**
 * Append the run suffix, idempotently.
 *
 * Idempotence matters because a resumed or salvaged run re-derives the branch
 * name from a plan that may already carry the suffix; appending twice would
 * produce a different branch and orphan the first one's commits.
 *
 * An empty or dash-only proposed name falls back to `fix/changes` rather than
 * producing a branch that starts with the suffix — a name says what the work is.
 */
export function appendRunSuffix(branchName: string, runId: string): string {
  const suffix = runIdBranchSuffix(runId);
  const normalizedBranch = branchName.trim().replace(/-+$/, "") || "fix/changes";
  if (!suffix || normalizedBranch.includes(suffix)) return normalizedBranch;
  return `${normalizedBranch}-${suffix}`;
}

/** Scope a plan's branch to one run, so concurrent runs cannot collide. */
export function withRunScopedBranchName<T extends BranchNamed>(plan: T, runId: string): T {
  return { ...plan, branchName: appendRunSuffix(plan.branchName, runId) };
}

/**
 * Continue on the branch a previous `code.change` already pushed to.
 *
 * A revision cycle must add commits to the existing PR's branch, not open a
 * second one — so the previous artifact's name WINS over the plan's. A missing,
 * blank or non-string value leaves the plan untouched rather than clearing it.
 */
export function withPreviousChangeBranch<T extends BranchNamed>(
  plan: T,
  previousCodeChange: JsonObject | null,
): T {
  const branchName =
    typeof previousCodeChange?.branchName === "string" ? previousCodeChange.branchName.trim() : "";
  return branchName.length > 0 ? { ...plan, branchName } : plan;
}
