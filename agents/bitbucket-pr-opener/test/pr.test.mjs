// Title and description of the bitbucket-pr-opener's pull/merge request.
// Dependency-free (node:test), run against the built dist.
//
// The forge shows this to a human before anyone reads the diff, so a title that
// is really a paragraph, or a heading followed by nothing, is a product defect.
import assert from "node:assert/strict";
import test from "node:test";
import { buildDescription, buildTitle } from "../dist/pr.js";

const change = {
  branchName: "fix/retry-budget",
  changedFiles: ["src/queue.ts", "src/retry.ts"],
  summary: "Add a per-issue retry budget.",
  issueNumber: 42,
};

test("the coder's first summary line becomes the title", () => {
  assert.equal(buildTitle(change), "Add a per-issue retry budget.");
});

test("a long first line is NOT used — forges do not wrap titles", () => {
  // This is why the later fallbacks exist at all.
  const wordy = { ...change, summary: `${"x".repeat(73)}\nmore` };
  assert.equal(buildTitle(wordy), "Resolve issue #42");
  assert.equal(buildTitle({ ...wordy, issueNumber: null }), "retry budget");
});

test("exactly 72 characters still passes; 73 does not", () => {
  const at = { ...change, summary: "y".repeat(72) };
  const over = { ...change, summary: "y".repeat(73) };
  assert.equal(buildTitle(at), "y".repeat(72));
  assert.notEqual(buildTitle(over), "y".repeat(73));
});

test("the branch fallback de-slugs and drops the type prefix", () => {
  const bare = {
    branchName: "feature/add_retry-budget",
    changedFiles: [],
    summary: "",
    issueNumber: null,
  };
  assert.equal(buildTitle(bare), "add retry budget");
  assert.equal(buildTitle({ ...bare, branchName: "chore/x" }), "x");
});

test("a branch that de-slugs to nothing still yields a title", () => {
  const odd = { branchName: "fix/", changedFiles: [], summary: "", issueNumber: null };
  assert.equal(buildTitle(odd), "Changes on fix/");
});

test("both description sections always have content under them", () => {
  // A heading followed by nothing reads as a broken template, and a reviewer who
  // sees one stops trusting the rest of the body.
  const body = buildDescription({
    branchName: "b",
    changedFiles: [],
    summary: "",
    issueNumber: null,
  });
  assert.ok(body.includes("Automated change."));
  assert.ok(body.includes("No files changed."));
  assert.ok(!/## \w[\w ]*\n\n\n/.test(body), "no heading may be followed by a blank line");
});

test("changed files are listed, code-quoted so markdown does not eat them", () => {
  const body = buildDescription(change);
  assert.ok(body.includes("- `src/queue.ts`"));
  assert.ok(body.includes("- `src/retry.ts`"));
});

test("the description is attributed to this agent", () => {
  assert.ok(buildDescription(change).includes("bitbucket-pr-opener agent."));
});

test("rendering is deterministic", () => {
  assert.equal(buildDescription(change), buildDescription(change));
  assert.equal(buildTitle(change), buildTitle(change));
});
