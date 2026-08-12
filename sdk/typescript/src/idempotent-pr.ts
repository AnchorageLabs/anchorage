/**
 * Opening a pull request without opening it twice.
 *
 * Every PR-opening agent faces the same race with itself: a run can be retried,
 * resumed, or salvaged, and the branch it pushes may already have an open PR from
 * the previous attempt. Creating a second one is not a cosmetic duplicate — it
 * splits review across two threads and leaves one of them to be closed by hand.
 *
 * The reference agents had drifted apart on this. `pr-opener` (GitHub) looked for
 * an existing PR **before** creating. `bitbucket-pr-opener` and
 * `gitlab-pr-opener` only looked **after** a create had already failed, and did
 * the lookup as `findOpen().catch(() => null)` — so "no PR exists" and "the
 * lookup itself failed" were the same answer. That second part is the expensive
 * one: a transient lookup failure while a PR *does* exist makes the agent report
 * `create_failed` on work that actually succeeded.
 *
 * This encodes the order all three should follow, with the two asymmetries that
 * matter:
 *
 *  - **the pre-check fails open.** If looking up an existing PR throws, we create
 *    anyway. A lookup outage must not stop an agent from opening a PR — the worst
 *    case is a duplicate, and the recovery path below still catches it.
 *  - **the recovery lookup's failure is reported, not swallowed.** When create
 *    fails and the follow-up lookup also fails, the caller is told both, because
 *    "the PR may exist and we could not check" is a different operational state
 *    from "there is no PR".
 */

export type ResolveOrCreateOutcome<T> =
  | { created: true; pr: T }
  | { failure: string; kind: "create-failed" }
  | { reused: true; pr: T };

export interface ResolveOrCreateDeps<T> {
  /** Look for an already-open PR/MR for this branch. May throw. */
  findOpen: () => Promise<null | T>;
  /** Create the PR/MR. May throw. */
  create: () => Promise<T>;
  /** Called when an existing PR was found before creating, for event emission. */
  onReuse?: (pr: T) => void;
  /** Called when the pre-create lookup threw, so a degraded check is visible. */
  onPreCheckFailed?: (message: string) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reuse an open PR if there is one, otherwise create — and if creating fails,
 * check once more before reporting failure.
 *
 * Never throws: every path resolves to an outcome the caller can act on.
 */
export async function resolveOrCreatePr<T>(
  deps: ResolveOrCreateDeps<T>,
): Promise<ResolveOrCreateOutcome<T>> {
  // 1. Pre-check, fail-open.
  try {
    const existing = await deps.findOpen();
    if (existing) {
      deps.onReuse?.(existing);
      return { reused: true, pr: existing };
    }
  } catch (error) {
    deps.onPreCheckFailed?.(messageOf(error));
  }

  // 2. Create.
  try {
    return { created: true, pr: await deps.create() };
  } catch (createError) {
    // 3. The create may have failed BECAUSE a PR already exists — a race with a
    //    concurrent attempt, or a pre-check that failed open above.
    try {
      const existing = await deps.findOpen();
      if (existing) {
        deps.onReuse?.(existing);
        return { reused: true, pr: existing };
      }
      return { kind: "create-failed", failure: messageOf(createError) };
    } catch (lookupError) {
      // Both failed. Say so: "the PR may exist and we could not check" is not
      // the same operational state as "there is no PR", and collapsing them is
      // how an agent reports failure on work that succeeded.
      return {
        kind: "create-failed",
        failure:
          `${messageOf(createError)} (and the follow-up check for an existing ` +
          `pull request also failed: ${messageOf(lookupError)} — a PR may exist)`,
      };
    }
  }
}
