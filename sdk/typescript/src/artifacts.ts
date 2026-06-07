// Canonical artifact type a quality-gate agent (tester today; reviewer/ci-watcher
// later) emits when it wants the coder to revise the change rather than fail the
// run outright. The orchestrator carries it back to the coder to close the
// feedback loop (see anchorage-orchestrator feedbackLoops).
export const REVISION_REQUEST_ARTIFACT_TYPE = "code.revision.request";

export interface RevisionFailure {
  /** Stable identifier for the failing check (e.g. the test command name). */
  name: string;
  /** The command that produced the failure, when one was run. */
  command?: string;
  /** Trimmed, human-readable detail (stderr/stdout excerpt or message). */
  details?: string;
}

export interface RevisionRequest {
  /** Agent that detected the failure and is asking the coder to revise. */
  fromAgent: string;
  /** Machine-readable failure category (e.g. "test_failed"). */
  reason: string;
  /** One-line human summary the coder reads first. */
  summary: string;
  /** Concrete failures the coder must address before the gate passes. */
  failures: RevisionFailure[];
}

// Detail excerpts are bounded so a revision artifact (which travels through the
// task envelope on every loop-back) cannot balloon from a noisy test log. Mirrors
// the tester's existing 4000-char output slicing.
const DEFAULT_MAX_DETAIL_LENGTH = 4000;

/**
 * Build a normalized `code.revision.request` artifact body. Centralizing the
 * shape here keeps every emitter (tester, and later reviewer/ci-watcher) and the
 * coder consumer on identical field names — a look-alike mismatch would silently
 * break the loop.
 */
export function buildRevisionRequest(
  request: RevisionRequest,
  options: { maxDetailLength?: number } = {},
): RevisionRequest {
  const maxDetailLength = options.maxDetailLength ?? DEFAULT_MAX_DETAIL_LENGTH;
  return {
    fromAgent: request.fromAgent,
    reason: request.reason,
    summary: request.summary,
    failures: request.failures.map((failure) => ({
      name: failure.name,
      ...(failure.command !== undefined ? { command: failure.command } : {}),
      ...(failure.details !== undefined
        ? { details: failure.details.slice(0, maxDetailLength) }
        : {}),
    })),
  };
}
