// The plan comment the planner posts on the issue. Dependency-free (node:test),
// run against the built dist.
//
// This is how a human first sees what the agent intends to do BEFORE any code is
// written — the cheapest point at which someone can say "no, not like that". An
// empty section or a missing branch name is the difference between a reviewable
// intention and a wall of text nobody reads.
import assert from "node:assert/strict";
import test from "node:test";
import { buildPlanComment } from "../dist/comment.js";

const plan = {
  planId: "plan_123",
  goal: "Stop one poisoned issue consuming all run volume.",
  branchName: "fix/retry-budget",
  implementationSteps: ["Add a budget column", "Check it at claim time"],
  acceptanceCriteria: ["A fourth attempt is refused", "Existing runs are unaffected"],
  risks: ["A budget can mask a permanent failure"],
};

test("the three facts a reviewer needs are all present and labelled", () => {
  const out = buildPlanComment(plan);
  assert.match(out, /\*\*Goal:\*\* Stop one poisoned issue/);
  // The branch and plan id are code-quoted so they survive markdown intact — a
  // branch like `fix/a_b` would otherwise render with the underscore eaten.
  assert.match(out, /\*\*Branch:\*\* `fix\/retry-budget`/);
  assert.match(out, /\*\*Plan ID:\*\* `plan_123`/);
});

test("steps and acceptance criteria render as lists, in order", () => {
  const out = buildPlanComment(plan);
  assert.ok(out.includes("- Add a budget column\n- Check it at claim time"));
  assert.ok(out.includes("- A fourth attempt is refused"));
  assert.ok(
    out.indexOf("### Steps") < out.indexOf("### Acceptance criteria"),
    "steps come before acceptance criteria",
  );
});

test("Risks is omitted when there are none, never a bare heading", () => {
  // An empty "### Risks" reads as "we did not think about it" — worse than not
  // raising the question.
  assert.ok(!buildPlanComment({ ...plan, risks: [] }).includes("### Risks"));
  assert.ok(buildPlanComment(plan).includes("### Risks"));
});

test("an empty step list still produces a well-formed comment", () => {
  // A plan with no steps is a planner bug, but the comment must not become
  // malformed markdown on top of it — the reader needs to SEE that it is empty.
  const empty = { ...plan, implementationSteps: [], acceptanceCriteria: [], risks: [] };
  const out = buildPlanComment(empty);
  assert.ok(out.startsWith("## Anchorage Plan"));
  assert.ok(out.includes("### Steps"));
  assert.ok(out.includes("### Acceptance criteria"));
  assert.ok(out.trimEnd().endsWith("agent.*"), "the attribution footer always closes it");
});

test("it is attributed, so a reader knows what wrote it", () => {
  assert.ok(
    buildPlanComment(plan).includes(
      "*Posted by [planner](https://github.com/AnchorageLabs/anchorage) agent.*",
    ),
  );
});

test("rendering is deterministic", () => {
  assert.equal(buildPlanComment(plan), buildPlanComment(plan));
});
