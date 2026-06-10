// Rendering tests for the first-touch triage comment. Dependency-free
// (node:test), run against the built dist with `node --test`.

import assert from "node:assert/strict";
import test from "node:test";
import { TRIAGE_COMMENT_MARKER, triageCommentBody } from "../dist/comment.js";

const base = {
  scope: "bug",
  type: "backend",
  priority: "high",
  readiness: "ready",
  agentEligible: true,
  duplicateOf: null,
  questions: [],
  reasoning: "Clear reproduction steps and a referenced file.",
};

test("eligible issue: marker present, proceeding message", () => {
  const body = triageCommentBody(base);
  assert.ok(body.startsWith(TRIAGE_COMMENT_MARKER));
  assert.match(body, /ready for autonomous handling/);
  assert.match(body, /\| bug \| backend \| high \| ready \|/);
});

test("needs-detail: questions render as a checklist", () => {
  const body = triageCommentBody({
    ...base,
    readiness: "needs-detail",
    agentEligible: false,
    questions: ["Which command fails?", "What Node version?"],
  });
  assert.match(body, /- \[ \] Which command fails\?/);
  assert.match(body, /- \[ \] What Node version\?/);
  assert.doesNotMatch(body, /ready for autonomous handling/);
});

test("duplicate wins over other branches", () => {
  const body = triageCommentBody({
    ...base,
    duplicateOf: 42,
    readiness: "needs-detail",
    questions: ["ignored"],
  });
  assert.match(body, /duplicate #42/);
  assert.doesNotMatch(body, /- \[ \]/);
});

test("ineligible without questions: plain not-eligible message", () => {
  const body = triageCommentBody({
    ...base,
    readiness: "out-of-scope",
    agentEligible: false,
  });
  assert.match(body, /not currently eligible/);
});
