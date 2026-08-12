// Deriving a GitHub-style issue number from a Linear identifier.
// Dependency-free (node:test), run against the built dist.
//
// This number leaves the agent: it travels in the issue.summary artifact through
// the planner and coder to the pr-opener, which renders `Closes #N` into the PR
// body. So a wrong number does not produce a wrong log line — MERGING THE PR
// CLOSES AN UNRELATED REAL ISSUE.
import assert from "node:assert/strict";
import test from "node:test";
import { numberFromIdentifier } from "../dist/issue-number.js";

test("the normal case: the numeric tail is the issue number", () => {
  assert.equal(numberFromIdentifier("ENG-45"), 45);
  assert.equal(numberFromIdentifier("ENG-1"), 1);
  assert.equal(numberFromIdentifier("LONGTEAM-9999"), 9999);
});

test("an un-derivable number is 0, NOT 1 — it used to be 1", () => {
  // The bug this pins: returning 1 meant the PR said `Closes #1`, and merging it
  // closed issue #1 of the repository. 0 is the protocol's existing value for
  // "there is no issue number" (the planner's parseIssueSummary allows it for the
  // plan-only flow) and it is falsy, so pr-opener omits `Closes #` entirely.
  for (const value of ["ENG-abc", "ENG-", "ENG", "", "a-uuid-like-9f2c", "ENG-0"]) {
    assert.equal(
      numberFromIdentifier(value),
      0,
      `must not fabricate a number for: ${JSON.stringify(value)}`,
    );
  }
});

test("the tail after the LAST dash is what counts", () => {
  // `ENG--1` is a malformed key, but its trailing segment genuinely is "1", so
  // deriving 1 is correct here — validating the key's SHAPE is a separate concern
  // from reading its number, and conflating them would make this function guess.
  assert.equal(numberFromIdentifier("ENG--1"), 1);
});

test("a UUID yields 0 rather than a fabricated number", () => {
  // This agent accepts an issue id on purpose, and a UUID has no issue number.
  assert.equal(numberFromIdentifier("f47ac10b-58cc-4372-a567-0e02b2c3d479"), 0);
});

test("zero and negatives are refused, not coerced", () => {
  assert.equal(numberFromIdentifier("ENG-0"), 0);
  assert.equal(numberFromIdentifier("ENG-00"), 0);
});

test("the result is always a safe integer, never NaN", () => {
  for (const value of ["ENG-abc", "ENG-1e5", "ENG-Infinity", "ENG-NaN"]) {
    const n = numberFromIdentifier(value);
    assert.ok(Number.isInteger(n), `${value} -> ${n}`);
    assert.ok(n >= 0);
  }
});
