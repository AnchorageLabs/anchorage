/**
 * Deriving a GitHub-style issue number from a Jira key.
 *
 * The number matters far outside this agent: it travels in the `issue.summary`
 * artifact through the planner and coder to the `pr-opener`, which renders
 * `Closes #N` into the pull request body. So a wrong number does not produce a
 * wrong log line — **merging the PR closes an unrelated real issue.**
 *
 * This used to return **1** when the number could not be derived. A Jira
 * reference with no numeric tail (a UUID, which this agent accepts on purpose,
 * or `PROJ-0`) therefore became issue 1, and the PR said `Closes #1`.
 *
 * It now returns **0**, which is not a fallback invented here — it is the
 * protocol's existing value for "there is no issue number", allowed explicitly by
 * the planner's `parseIssueSummary` for the plan-only flow, and falsy, so
 * `pr-opener`'s `if (codeChange.issueNumber)` omits `Closes #` entirely.
 * Saying "I don't know" is the only safe answer when the alternative is closing
 * someone else's issue.
 */

/** 0 when no positive integer can be derived — never a guess. */
export function numberFromKey(key: string): number {
  const n = Number(key.split("-").at(-1));
  return Number.isInteger(n) && n > 0 ? n : 0;
}
