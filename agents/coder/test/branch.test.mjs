// Branch naming for a coder run. Dependency-free (node:test), run against the
// built dist.
//
// Why this is worth pinning: the planner derives the branch name from the issue,
// so two runs on the same issue propose the SAME name. Runs execute
// concurrently and each pushes — a shared name means the second push rejects or
// lands on top of the first run's work. None of this logic had a test.
import assert from "node:assert/strict";
import test from "node:test";
import {
  appendRunSuffix,
  runIdBranchSuffix,
  withPreviousChangeBranch,
  withRunScopedBranchName,
} from "../dist/branch.js";

test("the suffix is a git-safe tail of the run id", () => {
  // The tail of "run-srv-1781991141437-0" (23 chars) — 12 chars, git-safe.
  assert.equal(runIdBranchSuffix("run_srv_1781991141437_0"), "1991141437-0");
  assert.match(runIdBranchSuffix("Run/SRV::9981"), /^[a-z0-9-]+$/);
  assert.equal(runIdBranchSuffix(""), "");
});

test("it takes the TAIL, because run ids share a long common prefix", () => {
  // This is the whole point. Two ids from the same server differ only near the
  // end, so a head-based suffix would produce the same branch for both — which
  // is exactly the collision the suffix exists to prevent.
  const a = runIdBranchSuffix("run_srv_1781991141437_0");
  const b = runIdBranchSuffix("run_srv_1781991141999_0");
  assert.notEqual(a, b);
});

test("distinct runs on the same plan get distinct branches", () => {
  const plan = { branchName: "fix/retry-budget" };
  const first = withRunScopedBranchName(plan, "run_srv_1781991141437_0");
  const second = withRunScopedBranchName(plan, "run_srv_1781991141999_0");
  assert.notEqual(first.branchName, second.branchName);
  assert.ok(first.branchName.startsWith("fix/retry-budget-"));
});

test("appending is idempotent, so a resumed run keeps its branch", () => {
  // A resumed or salvaged run re-derives the name from a plan that may already
  // carry the suffix. Appending twice would produce a different branch and
  // orphan the first attempt's commits.
  const runId = "run_srv_1781991141437_0";
  const once = appendRunSuffix("fix/thing", runId);
  assert.equal(appendRunSuffix(once, runId), once);
  assert.equal(appendRunSuffix(appendRunSuffix(once, runId), runId), once);
});

test("an empty or dash-only name becomes fix/changes, not a bare suffix", () => {
  // A branch name should say what the work is; starting it with the run id would
  // not.
  assert.equal(appendRunSuffix("", "run_1"), "fix/changes-run-1");
  assert.equal(appendRunSuffix("   ", "run_1"), "fix/changes-run-1");
  assert.equal(appendRunSuffix("---", "run_1"), "fix/changes-run-1");
});

test("a trailing dash never doubles up", () => {
  assert.equal(appendRunSuffix("fix/thing-", "run_1"), "fix/thing-run-1");
  assert.ok(!appendRunSuffix("fix/thing--", "run_1").includes("---"));
});

test("with no usable run id the plan's own name survives untouched", () => {
  assert.equal(appendRunSuffix("fix/thing", ""), "fix/thing");
  assert.equal(appendRunSuffix("fix/thing", "___"), "fix/thing");
});

test("a revision cycle continues on the previous change's branch", () => {
  // It must add commits to the existing PR's branch, not open a second one — so
  // the previous artifact's name wins over the plan's.
  const plan = { branchName: "fix/from-the-plan" };
  const out = withPreviousChangeBranch(plan, { branchName: "fix/already-pushed" });
  assert.equal(out.branchName, "fix/already-pushed");
});

test("a missing, blank or non-string previous branch leaves the plan alone", () => {
  const plan = { branchName: "fix/from-the-plan" };
  for (const previous of [null, {}, { branchName: "" }, { branchName: "   " }, { branchName: 7 }]) {
    assert.equal(
      withPreviousChangeBranch(plan, previous).branchName,
      "fix/from-the-plan",
      `previous: ${JSON.stringify(previous)}`,
    );
  }
});

test("both helpers copy the plan rather than mutating it", () => {
  const plan = { branchName: "fix/thing", planId: "p1" };
  withRunScopedBranchName(plan, "run_1");
  withPreviousChangeBranch(plan, { branchName: "other" });
  assert.equal(plan.branchName, "fix/thing", "the caller's plan must be untouched");
  assert.equal(withRunScopedBranchName(plan, "run_1").planId, "p1", "other fields survive");
});
