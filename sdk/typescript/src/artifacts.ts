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

// ── Runtime preview ───────────────────────────────────────────────────────────

// Canonical artifact the runtime agent emits after attempting to run the
// reviewed change locally. It is the contract between the runtime agent (emitter)
// and the orchestrator's pre-merge approval gate (consumer): the orchestrator
// reads `status` to decide whether to pause the run for human inspection
// (`running`) or continue straight to merge (`not_applicable`), and `previewUrl`
// to tell the user where to look. Keeping the shape here stops the two repos from
// drifting on field names the way a look-alike would.
export const RUNTIME_PREVIEW_ARTIFACT_TYPE = "runtime.preview";

/**
 * Outcome of the runtime agent:
 * - `running`        — services started and a preview URL is reachable; the
 *                      pipeline should pause for the user to inspect it.
 * - `not_applicable` — nothing to preview (docs-only change, a library with no
 *                      runnable entrypoint, or no deployable surface); the
 *                      pipeline continues to merge without pausing.
 * - `failed`         — a runnable solution was detected but it would not start /
 *                      become healthy; the pipeline finishes without merging.
 */
export type RuntimePreviewStatus = "running" | "not_applicable" | "failed";

/**
 * How the runtime agent decided to run the solution. This is what gets persisted
 * to `.anchorage/runtime.json` so future runs can skip detection and start
 * faster; it is updated whenever the working strategy changes.
 */
export interface RuntimeStrategy {
  /** Strategy family, e.g. "docker-compose" | "node" | "static" | "make" | "python". */
  kind: string;
  /** Shell command that starts the solution (run detached). */
  startCommand: string;
  /** Working directory for the commands, relative to the repo root ("." by default). */
  cwd?: string;
  /** Port the preview listens on, when known. */
  port?: number;
  /** URL polled for readiness and shown to the user. */
  url?: string;
  /** Shell command that tears the detached services down again. */
  stopCommand?: string;
  /** Whether this strategy came from the cache or fresh detection. */
  source?: "cache" | "detected";
}

export interface RuntimePreview {
  /** What happened — drives the orchestrator's pause/continue/stop decision. */
  status: RuntimePreviewStatus;
  /** One-line human summary shown in the UI / event stream. */
  summary: string;
  /** Local URL to open for inspection. Present when `status` is "running". */
  previewUrl?: string;
  /** The strategy used (or detected). Present when a strategy was resolved. */
  strategy?: RuntimeStrategy;
  /** Command to stop the detached services, surfaced for manual teardown. */
  stopCommand?: string;
  /** Failure detail. Present when `status` is "failed". */
  error?: string;
}

/**
 * Build a normalized `runtime.preview` artifact body. Centralizing the shape
 * keeps the runtime agent and the orchestrator's approval gate on identical
 * field names.
 */
export function buildRuntimePreview(preview: RuntimePreview): RuntimePreview {
  return {
    status: preview.status,
    summary: preview.summary,
    ...(preview.previewUrl !== undefined ? { previewUrl: preview.previewUrl } : {}),
    ...(preview.strategy !== undefined ? { strategy: preview.strategy } : {}),
    ...(preview.stopCommand !== undefined ? { stopCommand: preview.stopCommand } : {}),
    ...(preview.error !== undefined ? { error: preview.error } : {}),
  };
}
