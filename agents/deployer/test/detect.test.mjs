// Which GitHub workflow is "the deploy workflow". Dependency-free (node:test),
// run against the built dist.
//
// The agent dispatches whatever this picks, so a wrong pick does not fail — it
// runs the wrong workflow against a real environment.
import assert from "node:assert/strict";
import test from "node:test";
import { rankWorkflowFiles, score } from "../dist/detect.js";

test("deploy is the strongest hint, because it is the only unambiguous word", () => {
  // release/stage/ship all name things that are sometimes deploys and sometimes
  // not; "deploy" does not.
  assert.equal(score("production-deploy.yml"), 3);
  assert.equal(score("deploy.yaml"), 3);
  assert.ok(score("deploy.yml") > score("release.yml"));
});

test("cd counts as a whole token, and only as a whole token", () => {
  // The bug this pins: `/cd/` as a SUBSTRING matched any filename containing
  // those two letters, so a CDN-invalidation workflow could rank above a
  // genuinely-unhinted main.yml that was the real deploy.
  assert.equal(score("cd.yml"), 2);
  assert.equal(score("deploy-cd.yml"), 3);
  assert.equal(score("cdn-purge.yml"), 0, "cdn is not cd");
  assert.equal(score("abcd.yml"), 0, "abcd is not cd");
  assert.equal(score("cdk-synth.yml"), 0, "cdk is not cd");
});

test("release, stage and ship are weaker hints, not zero", () => {
  for (const file of ["release.yml", "stage-deploy-app.yml", "ship-it.yml"]) {
    assert.ok(score(file) >= 2, file);
  }
});

test("an unhinted filename scores zero rather than being excluded", () => {
  // Scoring only sets the ORDER — eligibility is decided by reading the file for
  // workflow_dispatch and an environment input, so a zero-scored main.yml is
  // still a candidate.
  assert.equal(score("main.yml"), 0);
  assert.equal(score("ci.yml"), 0);
});

test("both YAML extensions are handled, and the extension never scores", () => {
  assert.equal(score("deploy.yml"), score("deploy.yaml"));
});

test("ranking is deterministic — the same checkout must pick the same workflow", () => {
  // readdir order is not a guarantee, so equally-scored files tie-break by name.
  const files = ["main.yml", "zz-deploy.yml", "aa-deploy.yml", "cd.yml", "ci.yml"];
  const first = rankWorkflowFiles(files);
  assert.deepEqual(first, rankWorkflowFiles([...files].reverse()));
  assert.deepEqual(first.slice(0, 3), ["aa-deploy.yml", "zz-deploy.yml", "cd.yml"]);
});

test("ranking does not mutate the caller's array", () => {
  const files = ["main.yml", "deploy.yml"];
  rankWorkflowFiles(files);
  assert.deepEqual(files, ["main.yml", "deploy.yml"]);
});

test("an empty list ranks to an empty list", () => {
  assert.deepEqual(rankWorkflowFiles([]), []);
});
