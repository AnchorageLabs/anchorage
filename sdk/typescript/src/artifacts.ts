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

// ── Deploy preview ────────────────────────────────────────────────────────────

// Canonical artifact the deployer agent emits after deploying the run's branch
// to a chosen environment (stage). Same contract as runtime.preview, but the
// preview is a REAL deployed environment instead of a local server: the
// orchestrator's approval gate reads `status` to pause for human inspection
// (`running`) and `previewUrl` to point the user at the live stage.
export const DEPLOY_PREVIEW_ARTIFACT_TYPE = "deploy.preview";

/**
 * Outcome of the deployer agent:
 * - `running`        — the deploy was triggered and the environment is live (a
 *                      URL is reachable, or the deploy workflow/Deployment
 *                      succeeded); the pipeline pauses for the user to inspect.
 * - `not_applicable` — nothing deployable / no environment selected; the
 *                      pipeline continues without pausing.
 * - `failed`         — the deploy was triggered but did not become healthy; the
 *                      pipeline finishes without opening the PR.
 */
export type DeployPreviewStatus = "running" | "not_applicable" | "failed";

/** How the deployer triggered the deploy (auto-detected per repo). */
export interface DeployTrigger {
  /** "workflow_dispatch" (a deploy workflow) | "deployment" (Deployments API). */
  kind: "workflow_dispatch" | "deployment";
  /** The dispatched workflow file/id, when kind is "workflow_dispatch". */
  workflow?: string;
  /** The GitHub Deployment id, when kind is "deployment". */
  deploymentId?: number;
  /** The Actions run / status URL on GitHub, for traceability. */
  runUrl?: string;
}

export interface DeployPreview {
  /** What happened — drives the orchestrator's pause/continue/stop decision. */
  status: DeployPreviewStatus;
  /** One-line human summary shown in the UI / event stream. */
  summary: string;
  /** The environment/stage deployed to (e.g. "stg", "dev", "prd"). */
  environment: string;
  /** The branch that was deployed (the run's working branch). */
  ref?: string;
  /** Live URL of the deployed stage to open for inspection. */
  previewUrl?: string;
  /** How the deploy was triggered. */
  trigger?: DeployTrigger;
  /** Failure detail. Present when `status` is "failed". */
  error?: string;
}

/**
 * Build a normalized `deploy.preview` artifact body. Centralizing the shape
 * keeps the deployer agent and the orchestrator's approval gate on identical
 * field names (mirrors {@link buildRuntimePreview}).
 */
export function buildDeployPreview(preview: DeployPreview): DeployPreview {
  return {
    status: preview.status,
    summary: preview.summary,
    environment: preview.environment,
    ...(preview.ref !== undefined ? { ref: preview.ref } : {}),
    ...(preview.previewUrl !== undefined ? { previewUrl: preview.previewUrl } : {}),
    ...(preview.trigger !== undefined ? { trigger: preview.trigger } : {}),
    ...(preview.error !== undefined ? { error: preview.error } : {}),
  };
}
