// Shared rate-limit/transient retry for HTTP providers. A 429 inside one LLM
// turn used to fail the whole agent (exit 6), forcing the orchestrator to
// re-run the step from scratch — the dominant failure class in the 2026-06-10
// OpenObserve analysis (32 coder exit-6 spans, mostly provider 429s). Retrying
// here, honouring `retry-after`, keeps the turn alive at the cost of seconds
// instead of re-burning the agent's whole context at the cost of a retry loop.

/** Statuses worth retrying: rate limits, overload, and transient 5xx. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

// Per-request wall-clock cap for an LLM HTTP call. Node's global fetch has no
// response timeout, so a provider that accepts the connection but never answers
// (or a stalled stream) hangs the whole turn — and therefore the whole agent —
// forever. This bounds every request; an abort surfaces as a normal network
// error, which the turn maps to `network_error` and the orchestrator retries.
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export function llmRequestTimeoutMs(): number {
  const raw = process.env.ANCHORAGE_LLM_TIMEOUT_MS;
  if (raw && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * `fetch` with a hard timeout via AbortController. On timeout the request is
 * aborted and a clear Error is thrown (not a silent hang). Pass an external
 * `signal` to compose with a caller's cancellation.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = llmRequestTimeoutMs(),
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`LLM request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Extra attempts after the first (4 requests total). */
export const MAX_RATE_LIMIT_RETRIES = 3;

const MAX_DELAY_MS = 60_000;

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/**
 * Parse a `retry-after` header value (seconds or HTTP-date form) into a capped
 * delay in ms, or null when the header is absent/unparseable. Shared by the HTTP
 * and AWS paths so both honour a server-supplied backoff identically.
 */
function retryAfterMs(header: string | null | undefined): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_DELAY_MS);
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(date - Date.now(), 0), MAX_DELAY_MS);
  }
  return null;
}

/** Exponential backoff (5s, 10s, 20s…), capped at 60s. */
function backoffMs(attempt: number): number {
  return Math.min(5_000 * 2 ** attempt, MAX_DELAY_MS);
}

/**
 * Delay before the next attempt: the server's `retry-after` when present
 * (seconds or HTTP-date form), else exponential backoff (5s, 10s, 20s),
 * capped at 60s so a hostile header cannot stall a turn.
 */
export function retryDelayMs(response: Response, attempt: number): number {
  return retryAfterMs(response.headers.get("retry-after")) ?? backoffMs(attempt);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `send` until it returns a non-retryable response or retries are
 * exhausted. Network errors are NOT retried here — the caller already maps
 * them to `network_error` and the orchestrator's transient-step retry covers
 * genuinely dead networks.
 */
export async function sendWithRateLimitRetry(send: () => Promise<Response>): Promise<Response> {
  let response = await send();
  for (let attempt = 0; attempt < MAX_RATE_LIMIT_RETRIES; attempt++) {
    if (response.ok || !isRetryableStatus(response.status)) return response;
    await sleep(retryDelayMs(response, attempt));
    response = await send();
  }
  return response;
}

// --- AWS / Bedrock throttle retry ------------------------------------------
// Bedrock's Converse API surfaces rate limits and transient capacity as THROWN
// SDK exceptions, not HTTP Response objects — so the fetch path above never sees
// them and a single 429 used to fail the whole agent step (the GITHUB_TOKEN /
// 429 failure class from the OpenObserve analysis). Same intent, throw-shaped:
// a throttle costs seconds of backoff here instead of a full step re-run.

/** AWS SDK error names worth retrying: rate limits, capacity, transient 5xx. */
const RETRYABLE_AWS_ERROR_NAMES = new Set([
  "ThrottlingException",
  "TooManyRequestsException",
  "ServiceQuotaExceededException",
  "ServiceUnavailableException",
  "InternalServerException",
  "ModelTimeoutException",
  "ModelNotReadyException",
]);

/**
 * True when a thrown AWS SDK error is a rate-limit/transient failure. Matches on
 * the HTTP status the SDK records in `$metadata`, the exception `name`, or the
 * SDK's own `$retryable` tag — any one is enough.
 */
export function isRetryableAwsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
    $retryable?: unknown;
  };
  const status = e.$metadata?.httpStatusCode;
  if (typeof status === "number" && isRetryableStatus(status)) return true;
  if (typeof e.name === "string" && RETRYABLE_AWS_ERROR_NAMES.has(e.name)) return true;
  if (e.$retryable !== null && typeof e.$retryable === "object") return true;
  return false;
}

/**
 * Delay before retrying a thrown AWS error: honour a `retry-after` header on the
 * underlying HTTP response when present, else the same capped exponential
 * backoff as the HTTP path.
 */
export function awsRetryDelayMs(error: unknown, attempt: number): number {
  const headers = (error as { $response?: { headers?: Record<string, string> } } | null)?.$response
    ?.headers;
  const header = headers?.["retry-after"] ?? headers?.["Retry-After"];
  return retryAfterMs(header) ?? backoffMs(attempt);
}

/**
 * Run `send` (an AWS SDK call that THROWS on failure) until it succeeds, throws a
 * non-retryable error, or retries are exhausted — the throw-based analogue of
 * sendWithRateLimitRetry. Non-retryable errors (validation, auth, an unsupported
 * parameter) propagate immediately so the Bedrock adapter's param-compat retries
 * still see them.
 */
export async function sendAwsWithRetry<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (attempt >= MAX_RATE_LIMIT_RETRIES || !isRetryableAwsError(error)) throw error;
      await sleep(awsRetryDelayMs(error, attempt));
    }
  }
}
