// Did the deployment actually go live? Dependency-free (node:test), run against
// the built dist.
//
// A later step reads this verdict to decide whether the change is deployed, so a
// wrong `true` reports a shipped change that never shipped.
import assert from "node:assert/strict";
import test from "node:test";
import { isSuccessfulDeployment, SUCCESSFUL_DEPLOYMENT_STATUSES } from "../dist/status.js";

test("the known success words are recognised", () => {
  for (const status of ["deployed", "success", "succeeded", "ready"]) {
    assert.equal(isSuccessfulDeployment(status), true, status);
  }
});

test("matching is case-insensitive, because platforms disagree on casing", () => {
  for (const status of ["DEPLOYED", "Success", "sUcCeEdEd", "Ready"]) {
    assert.equal(isSuccessfulDeployment(status), true, status);
  }
});

test("an UNRECOGNISED status is not a success — it is an allowlist", () => {
  // "We do not recognise this" is not evidence that anything shipped. A new
  // platform's wording, a typo, or an empty string must not report a live deploy.
  for (const status of [
    "",
    "unknown",
    "in_progress",
    "queued",
    "building",
    "deploying",
    "error",
    "failure",
    "cancelled",
    "some_new_platform_word",
    "successful",
    "deploy",
  ]) {
    assert.equal(isSuccessfulDeployment(status), false, `must not pass: ${JSON.stringify(status)}`);
  }
});

test("near-misses do not pass, because substring matching would be a guess", () => {
  // `successful` and `deploy` are close to the real words but are not them; the
  // allowlist is exact so a partial match cannot silently qualify.
  assert.equal(isSuccessfulDeployment("successfully deployed"), false);
  assert.equal(isSuccessfulDeployment("not deployed"), false);
});

test("the vocabulary is exported so a consumer can see it, not guess it", () => {
  assert.deepEqual([...SUCCESSFUL_DEPLOYMENT_STATUSES].sort(), [
    "deployed",
    "ready",
    "succeeded",
    "success",
  ]);
});
