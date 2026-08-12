/**
 * The one-line CI verdict a human reads.
 *
 * The structured report carries every check; this line is what appears in the run
 * view and in the comment a reviewer skims. So the failing check NAMES matter: a
 * summary that says "CI failed: unknown check" when the names were available sends
 * someone to open the full report to learn what a sentence could have told them.
 *
 * Extracted from `index.ts` (nothing there was exported) so the naming can be
 * pinned. The verdict itself comes from the shared conclusion vocabulary in
 * `@anchorage/sdk`, which `merge-gate` also uses — the two agents disagreed about
 * `action_required` until that was unified.
 */

export type CiStatus = "failed" | "passed" | "pending";

/** Anything with a display name; both statuses and check runs have one. */
export interface NamedCheck {
  name: string;
}

export function summarizeCi(
  status: CiStatus,
  failed: readonly NamedCheck[],
  pending: readonly NamedCheck[],
): string {
  if (status === "passed") return "All observed CI checks and statuses passed.";
  if (status === "failed") {
    const names = failed.map((check) => check.name).join(", ");
    // "unknown check" is the honest fallback for a failure with no named source —
    // it says we know CI failed and cannot say which, rather than implying the
    // list was empty.
    return `CI failed: ${names || "unknown check"}.`;
  }
  const pendingNames = pending.map((check) => check.name).join(", ");
  return `CI is still pending: ${pendingNames || "checks not complete"}.`;
}
