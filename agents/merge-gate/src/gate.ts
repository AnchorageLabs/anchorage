/**
 * The two rules that decide whether an agent's code gets merged.
 *
 * This is the highest-consequence pure logic in the whole fleet: everything else
 * proposes, this one lands. A wrong `false` costs a retry; a wrong `true` merges
 * unreviewed or red code into a default branch. So both rules are written to
 * **fail closed**, and that is what the tests beside this pin.
 *
 * Extracted from `index.ts` (nothing there was exported) so the rules can be
 * exercised without an Octokit, a network, or a PR. The API calls stay in
 * `index.ts`; only the classification lives here.
 */

/** The reviewer's verdict vocabulary (see `agents/reviewer`). */
export const APPROVE_DECISION = "approve";

/**
 * May this PR be merged on the strength of the review?
 *
 * Only the exact string `"approve"` passes. Not "approved", not "APPROVE", not a
 * truthy object, not a missing value — because every one of those is a state
 * where we do not actually know that a reviewer approved, and the safe reading of
 * "I don't know" is no.
 *
 * `"unknown"` is the value `resolveReviewDecision` returns when the review
 * artifact is absent or unreadable, so an IO failure upstream lands here as a
 * refusal rather than as a merge.
 */
export function reviewAllowsMerge(reviewDecision: unknown): boolean {
  return reviewDecision === APPROVE_DECISION;
}

export type CiStatus = "failure" | "pending" | "success";

/** The shape this rule needs from GitHub's combined-status endpoint. */
export interface CombinedStatusView {
  state: string;
  totalCount: number;
}

/** The shape this rule needs from GitHub's check-runs endpoint. */
export interface CheckRunView {
  conclusion: null | string;
  status: null | string;
}

/**
 * Fold GitHub's two independent CI surfaces — legacy commit statuses and check
 * runs — into one verdict.
 *
 * Both must be consulted: a repo can use either or both, and reading only one
 * would call a red PR green. Precedence is failure > pending > success, so a
 * mixed state never resolves to mergeable.
 *
 * The one deliberately permissive case: **no CI configured at all** counts as
 * success. A repo with no checks would otherwise be permanently unmergeable,
 * which would make the agent useless on exactly the small repos it is easiest to
 * try it on. That is a real trade — it is why `reviewAllowsMerge` is strict.
 */
export function classifyCiStatus(
  combined: CombinedStatusView,
  checkRuns: readonly CheckRunView[],
): CiStatus {
  if (combined.totalCount === 0 && checkRuns.length === 0) return "success";

  const hasFailedStatus = combined.state === "failure" || combined.state === "error";
  const hasPendingStatus = combined.state === "pending" && combined.totalCount > 0;

  // `cancelled` and `timed_out` count as failures: neither is evidence the code
  // is good, and treating "we never found out" as success is how red code merges.
  const hasFailedCheck = checkRuns.some(
    (run) =>
      run.conclusion === "failure" ||
      run.conclusion === "cancelled" ||
      run.conclusion === "timed_out",
  );
  const hasPendingCheck = checkRuns.some(
    (run) => run.status === "queued" || run.status === "in_progress",
  );

  if (hasFailedStatus || hasFailedCheck) return "failure";
  if (hasPendingStatus || hasPendingCheck) return "pending";
  return "success";
}

export type MergeMethod = "merge" | "rebase" | "squash";

/**
 * Which merge button to press. `squash` is the default because an agent run's
 * intermediate commits are its working notes, not history anyone wants on the
 * default branch. An unrecognised value falls back to the default rather than
 * failing the run — a typo in configuration should not strand a green PR.
 */
export function resolveMergeMethod(envValue: string | undefined): MergeMethod {
  if (envValue === "merge" || envValue === "squash" || envValue === "rebase") return envValue;
  return "squash";
}
