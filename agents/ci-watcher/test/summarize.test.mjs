// The one-line CI verdict a human reads. Dependency-free (node:test), run against
// the built dist.
//
// The structured report carries every check; this line is what appears in the run
// view and the comment a reviewer skims. So the failing check NAMES matter — a
// summary that says "unknown check" when names were available sends someone to
// open the full report to learn what a sentence could have told them.
import assert from "node:assert/strict";
import test from "node:test";
import { summarizeCi } from "../dist/summarize.js";

const named = (...names) => names.map((name) => ({ name }));

test("a pass says so plainly", () => {
  assert.equal(summarizeCi("passed", [], []), "All observed CI checks and statuses passed.");
});

test("a failure NAMES every failing check", () => {
  assert.equal(summarizeCi("failed", named("build", "lint"), []), "CI failed: build, lint.");
});

test("statuses and check runs are named together, in the order given", () => {
  // The caller merges GitHub's two CI surfaces; the summary must not favour one.
  assert.equal(
    summarizeCi("failed", named("legacy-status", "check-run"), []),
    "CI failed: legacy-status, check-run.",
  );
});

test("a failure with no named source is honest, not empty", () => {
  // "unknown check" says we know CI failed and cannot say which — better than a
  // sentence that reads as though nothing failed.
  assert.equal(summarizeCi("failed", [], []), "CI failed: unknown check.");
});

test("pending names what is still running", () => {
  assert.equal(
    summarizeCi("pending", [], named("e2e", "deploy-preview")),
    "CI is still pending: e2e, deploy-preview.",
  );
});

test("pending with no names still explains itself", () => {
  assert.equal(summarizeCi("pending", [], []), "CI is still pending: checks not complete.");
});

test("the failed list is used for a failure and the pending list for pending", () => {
  // Crossing them would report the wrong checks, which is worse than no names.
  assert.ok(summarizeCi("failed", named("bad"), named("waiting")).includes("bad"));
  assert.ok(!summarizeCi("failed", named("bad"), named("waiting")).includes("waiting"));
  assert.ok(summarizeCi("pending", named("bad"), named("waiting")).includes("waiting"));
  assert.ok(!summarizeCi("pending", named("bad"), named("waiting")).includes("bad"));
});

test("a passed verdict ignores any lists it was handed", () => {
  assert.equal(
    summarizeCi("passed", named("stale-entry"), named("stale-entry")),
    "All observed CI checks and statuses passed.",
  );
});

test("summarising is deterministic", () => {
  const f = named("a", "b");
  assert.equal(summarizeCi("failed", f, []), summarizeCi("failed", f, []));
});
