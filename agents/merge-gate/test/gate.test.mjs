// The two rules that decide whether an agent's code gets merged. Dependency-free
// (node:test), run against the built dist.
//
// This is the highest-consequence pure logic in the fleet: every other agent
// proposes, this one lands. A wrong `false` costs a retry; a wrong `true` merges
// unreviewed or red code into a default branch. Both rules fail closed, and that
// asymmetry is what these pin.
import assert from "node:assert/strict";
import test from "node:test";
import { classifyCiStatus, resolveMergeMethod, reviewAllowsMerge } from "../dist/gate.js";

test("only the exact string approve permits a merge", () => {
  assert.equal(reviewAllowsMerge("approve"), true);
});

test("everything else refuses — including the near-misses", () => {
  // Each of these is a state where we do NOT know that a reviewer approved, and
  // the safe reading of "I don't know" is no. "unknown" in particular is what
  // resolveReviewDecision returns when the review artifact is missing or
  // unreadable, so an upstream IO failure lands here as a refusal, not a merge.
  for (const decision of [
    "approved",
    "APPROVE",
    " approve",
    "approve ",
    "request_changes",
    "unknown",
    "",
    null,
    undefined,
    0,
    1,
    true,
    {},
    { decision: "approve" },
    ["approve"],
  ]) {
    assert.equal(
      reviewAllowsMerge(decision),
      false,
      `must refuse: ${JSON.stringify(decision) ?? String(decision)}`,
    );
  }
});

const noStatuses = { state: "pending", totalCount: 0 };

test("no CI configured at all counts as success", () => {
  // Deliberately permissive: a repo with no checks would otherwise be
  // permanently unmergeable, which would make the agent useless on exactly the
  // small repos it is easiest to try it on. This is why the REVIEW rule is
  // strict — the two trade against each other.
  assert.equal(classifyCiStatus(noStatuses, []), "success");
});

test("a failing commit status fails, and so does a failing check run", () => {
  assert.equal(classifyCiStatus({ state: "failure", totalCount: 1 }, []), "failure");
  assert.equal(classifyCiStatus({ state: "error", totalCount: 1 }, []), "failure");
  assert.equal(
    classifyCiStatus(noStatuses, [{ conclusion: "failure", status: "completed" }]),
    "failure",
  );
});

test("cancelled and timed_out are failures, not successes", () => {
  // Neither is evidence the code is good. Treating "we never found out" as
  // success is precisely how red code merges.
  for (const conclusion of ["cancelled", "timed_out"]) {
    assert.equal(
      classifyCiStatus(noStatuses, [{ conclusion, status: "completed" }]),
      "failure",
      conclusion,
    );
  }
});

test("action_required BLOCKS — it used to merge, while ci-watcher called it failed", () => {
  // The divergence this fixes. Two agents classified the same thing and
  // disagreed: ci-watcher counted `action_required` as a failure, this did not.
  // So a check run explicitly asking a human to act read as SUCCESS here and the
  // PR merged — the watcher said CI failed and the gate merged it anyway, on the
  // same PR. `action_required` is the clearest possible "not yet".
  assert.equal(
    classifyCiStatus(noStatuses, [{ conclusion: "action_required", status: "completed" }]),
    "failure",
  );
});

test("stale blocks too — it belongs to a superseded commit", () => {
  assert.equal(
    classifyCiStatus(noStatuses, [{ conclusion: "stale", status: "completed" }]),
    "failure",
  );
});

test("an UNKNOWN conclusion blocks — GitHub can add one", () => {
  // Fail-closed on the vocabulary itself. A conclusion GitHub introduces later
  // silently counting as a pass is how an unreviewed state merges, so passing
  // conclusions are listed explicitly rather than inferred from "not blocking".
  assert.equal(
    classifyCiStatus(noStatuses, [{ conclusion: "some_future_conclusion", status: "completed" }]),
    "failure",
  );
});

test("neutral and skipped still pass — they are answers, not absences", () => {
  // A workflow saying "this did not apply here" must not block forever.
  for (const conclusion of ["neutral", "skipped"]) {
    assert.equal(
      classifyCiStatus(noStatuses, [{ conclusion, status: "completed" }]),
      "success",
      conclusion,
    );
  }
});

test("queued or running work is pending — never success", () => {
  for (const status of ["queued", "in_progress", "waiting"]) {
    assert.equal(classifyCiStatus(noStatuses, [{ conclusion: null, status }]), "pending", status);
  }
  assert.equal(classifyCiStatus({ state: "pending", totalCount: 2 }, []), "pending");
});

test("failure beats pending, so a mixed state never resolves to mergeable", () => {
  const mixed = [
    { conclusion: "failure", status: "completed" },
    { conclusion: null, status: "in_progress" },
  ];
  assert.equal(classifyCiStatus({ state: "pending", totalCount: 3 }, mixed), "failure");
});

test("both CI surfaces are consulted, not just one", () => {
  // A repo can use legacy commit statuses, check runs, or both. Reading only one
  // surface would call a red PR green.
  assert.equal(
    classifyCiStatus({ state: "success", totalCount: 1 }, [
      { conclusion: "failure", status: "completed" },
    ]),
    "failure",
    "a green status does not excuse a red check",
  );
  assert.equal(
    classifyCiStatus({ state: "failure", totalCount: 1 }, [
      { conclusion: "success", status: "completed" },
    ]),
    "failure",
    "a green check does not excuse a red status",
  );
});

test("all green on both surfaces is success", () => {
  assert.equal(
    classifyCiStatus({ state: "success", totalCount: 2 }, [
      { conclusion: "success", status: "completed" },
      { conclusion: "neutral", status: "completed" },
    ]),
    "success",
  );
});

test("squash is the default, and an unrecognised value falls back to it", () => {
  // An agent run's intermediate commits are its working notes, not history
  // anyone wants on a default branch. A typo in configuration should not strand
  // a green PR, so the fallback is silent rather than fatal.
  assert.equal(resolveMergeMethod(undefined), "squash");
  assert.equal(resolveMergeMethod(""), "squash");
  assert.equal(resolveMergeMethod("SQUASH"), "squash");
  assert.equal(resolveMergeMethod("fast-forward"), "squash");
});

test("the three real methods pass through", () => {
  for (const method of ["merge", "squash", "rebase"]) {
    assert.equal(resolveMergeMethod(method), method);
  }
});
