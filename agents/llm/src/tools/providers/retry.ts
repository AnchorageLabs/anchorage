// Shared rate-limit/transient retry for HTTP providers. A 429 inside one LLM
// turn used to fail the whole agent (exit 6), forcing the orchestrator to
// re-run the step from scratch — the dominant failure class in the 2026-06-10
// OpenObserve analysis (32 coder exit-6 spans, mostly provider 429s). Retrying
// here, honouring `retry-after`, keeps the turn alive at the cost of seconds
// instead of re-burning the agent's whole context at the cost of a retry loop.

/** Statuses worth retrying: rate limits, overload, and transient 5xx. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

/** Extra attempts after the first (4 requests total). */
export const MAX_RATE_LIMIT_RETRIES = 3;

const MAX_DELAY_MS = 60_000;

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/**
 * Delay before the next attempt: the server's `retry-after` when present
 * (seconds or HTTP-date form), else exponential backoff (5s, 10s, 20s),
 * capped at 60s so a hostile header cannot stall a turn.
 */
export function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_DELAY_MS);
    }
    const date = Date.parse(header);
    if (!Number.isNaN(date)) {
      return Math.min(Math.max(date - Date.now(), 0), MAX_DELAY_MS);
    }
  }
  return Math.min(5_000 * 2 ** attempt, MAX_DELAY_MS);
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
