// Bedrock surfaces 429/overload as THROWN SDK exceptions, not HTTP Responses, so
// the fetch retry path never saw them and one throttle failed the whole agent
// step. sendAwsWithRetry is the throw-based analogue: retry transient AWS errors
// with backoff, propagate everything else. Run with `node --test`.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const distRetry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/tools/providers/retry.js",
);
const { isRetryableAwsError, awsRetryDelayMs, sendAwsWithRetry, MAX_RATE_LIMIT_RETRIES } =
  await import(distRetry);

// A throttle response with retry-after: 0 keeps the test fast (zero backoff)
// while still exercising the header-honouring path.
function throttle() {
  return {
    name: "ThrottlingException",
    $metadata: { httpStatusCode: 429 },
    $response: { headers: { "retry-after": "0" } },
  };
}

test("isRetryableAwsError: throttling, transient 5xx, and $retryable tag", () => {
  assert.equal(isRetryableAwsError({ name: "ThrottlingException" }), true);
  assert.equal(isRetryableAwsError({ name: "ServiceUnavailableException" }), true);
  assert.equal(isRetryableAwsError({ $metadata: { httpStatusCode: 503 } }), true);
  assert.equal(isRetryableAwsError({ name: "Foo", $retryable: {} }), true);
});

test("isRetryableAwsError: validation/auth and non-objects are NOT retryable", () => {
  assert.equal(isRetryableAwsError({ name: "ValidationException" }), false);
  assert.equal(isRetryableAwsError({ $metadata: { httpStatusCode: 400 } }), false);
  assert.equal(isRetryableAwsError(new Error("boom")), false);
  assert.equal(isRetryableAwsError(null), false);
  assert.equal(isRetryableAwsError("ThrottlingException"), false);
});

test("awsRetryDelayMs: honours retry-after header, else exponential backoff", () => {
  assert.equal(awsRetryDelayMs({ $response: { headers: { "retry-after": "2" } } }, 0), 2000);
  // Header-cased variant resolves too.
  assert.equal(awsRetryDelayMs({ $response: { headers: { "Retry-After": "1" } } }, 0), 1000);
  // No header → 5s * 2**attempt.
  assert.equal(awsRetryDelayMs({}, 0), 5000);
  assert.equal(awsRetryDelayMs({}, 1), 10000);
});

test("sendAwsWithRetry: succeeds after transient throttles", async () => {
  let calls = 0;
  const result = await sendAwsWithRetry(async () => {
    calls++;
    if (calls < 3) throw throttle();
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("sendAwsWithRetry: gives up after MAX retries and rethrows the last error", async () => {
  let calls = 0;
  await assert.rejects(
    sendAwsWithRetry(async () => {
      calls++;
      throw throttle();
    }),
    (err) => err.name === "ThrottlingException",
  );
  // First attempt + MAX_RATE_LIMIT_RETRIES retries.
  assert.equal(calls, MAX_RATE_LIMIT_RETRIES + 1);
});

test("sendAwsWithRetry: a non-retryable error propagates immediately (no retries)", async () => {
  let calls = 0;
  await assert.rejects(
    sendAwsWithRetry(async () => {
      calls++;
      throw { name: "ValidationException", $metadata: { httpStatusCode: 400 } };
    }),
    (err) => err.name === "ValidationException",
  );
  assert.equal(calls, 1);
});
