/**
 * What GitHub's check-run conclusions mean for a merge decision.
 *
 * Two agents classify the same thing — `ci-watcher` reports CI state, `merge-gate`
 * decides whether to merge on it — and they **disagreed**. `ci-watcher` counted
 * `action_required` as a failure; `merge-gate` did not, so a check run demanding
 * human intervention read as **success** and the PR was merged. The watcher said
 * CI failed and the gate merged it anyway, on the same PR.
 *
 * One vocabulary, in the SDK, because "is this conclusion a pass" is a question
 * every agent that touches GitHub checks has to answer identically or the fleet
 * contradicts itself.
 *
 * The full conclusion set is `success` · `failure` · `neutral` · `cancelled` ·
 * `timed_out` · `action_required` · `skipped` · `stale`, plus `null` while a run
 * is still going.
 */

/**
 * Conclusions that must block a merge.
 *
 * The principle is that only evidence the code is GOOD may pass. `cancelled` and
 * `timed_out` are not that evidence — they mean we never found out — and
 * `action_required` is a check explicitly asking a human to do something first,
 * which is the clearest possible "not yet".
 */
export const BLOCKING_CHECK_CONCLUSIONS: readonly string[] = [
  "action_required",
  "cancelled",
  "failure",
  "stale",
  "timed_out",
];

/**
 * Conclusions that are a deliberate non-blocking outcome.
 *
 * `neutral` and `skipped` are a workflow saying "this did not apply here" — an
 * answer, not an absence — so they do not block. They are listed rather than
 * inferred from "not blocking", so a conclusion GitHub adds later is unrecognised
 * instead of silently treated as a pass.
 */
export const PASSING_CHECK_CONCLUSIONS: readonly string[] = ["neutral", "skipped", "success"];

/** Does this conclusion block a merge? An unrecognised conclusion does. */
export function checkConclusionBlocks(conclusion: null | string | undefined): boolean {
  if (conclusion === null || conclusion === undefined) return false; // still running — pending, not blocking
  if (PASSING_CHECK_CONCLUSIONS.includes(conclusion)) return false;
  // Deliberately fail-closed on anything unknown: GitHub can add a conclusion,
  // and a new one silently counting as a pass is how unreviewed states merge.
  return true;
}

/** Is this check run still in flight? */
export function checkRunIsPending(status: null | string | undefined): boolean {
  return status === "queued" || status === "in_progress" || status === "waiting";
}

/** Does this legacy commit-status state block a merge? */
export function commitStatusBlocks(state: null | string | undefined): boolean {
  return state === "failure" || state === "error";
}
