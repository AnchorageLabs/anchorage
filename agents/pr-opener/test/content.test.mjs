// What the pull request actually says. Dependency-free (node:test), run against
// the built dist.
//
// This is the first thing a human reads on an agent's work, and `pr-opener` is
// the third-highest-churn file in the agents tree (40 commits, 3,149 lines
// changed) with no tests — because nothing in its 950-line script was exported.
// A blank section or a title that is really a paragraph is a product defect, not
// a cosmetic one, so that is what these pin.
import assert from "node:assert/strict";
import test from "node:test";
import {
  assemblePrContent,
  buildFallbackTitle,
  changedFilesList,
  fallbackPrContent,
  parsePrContentJson,
  readString,
} from "../dist/content.js";

const change = {
  branchName: "fix/retry-budget",
  changedFiles: ["src/queue.ts", "src/retry.ts"],
  summary: "Add a per-issue retry budget.",
  issueNumber: 42,
};

const full = {
  title: "Add a per-issue retry budget",
  summary: "Stops one poisoned issue consuming all run volume.",
  why: "Two issues took 38% of all runs.",
  what: "A budget column plus the check at claim time.",
  how: "Counted attempts per (repo, issue) in the queue.",
  notes: "The budget is configurable.",
};

test("parses the sections the model returns", () => {
  assert.deepEqual(parsePrContentJson(JSON.stringify(full)), full);
});

test("tolerates prose or a fence around the object", () => {
  const wrapped = ["Here is the PR content:", "```json", JSON.stringify(full), "```", "Done."].join(
    "\n",
  );
  assert.equal(parsePrContentJson(wrapped)?.title, full.title);
});

test("title and why are REQUIRED — missing either routes to the fallback", () => {
  // Returning null is what sends the caller to fallbackPrContent. A PR with an
  // empty title is worse than one with a mechanical title.
  assert.equal(parsePrContentJson(JSON.stringify({ why: "no title" })), null);
  assert.equal(parsePrContentJson(JSON.stringify({ title: "no why" })), null);
  assert.equal(parsePrContentJson(JSON.stringify({ title: 7, why: "wrong type" })), null);
  assert.equal(parsePrContentJson("not json at all"), null);
  assert.equal(parsePrContentJson(""), null);
});

test("never throws, whatever the model returned", () => {
  for (const input of ["", "{", "}", "{{{", '{"title":', "null", "[]"]) {
    assert.doesNotThrow(() => parsePrContentJson(input), `input: ${JSON.stringify(input)}`);
  }
});

test("no heading is ever followed by whitespace", () => {
  // An empty `## Why` reads as a broken template, and a reviewer who sees one
  // stops trusting the rest of the body. Every section has a fallback.
  const empty = { title: "T", why: "", summary: "", what: "", how: "", notes: "" };
  const { body } = assemblePrContent(empty, change, null);
  for (const heading of ["## Summary", "## Why", "## What", "## How"]) {
    const after = body.split(`${heading}\n\n`)[1] ?? "";
    const firstLine = after.split("\n")[0] ?? "";
    assert.ok(firstLine.trim().length > 0, `${heading} was followed by nothing`);
  }
});

test("empty sections fall back to real content, not placeholders", () => {
  const partial = { title: "T", why: "Because.", summary: "", what: "", how: "", notes: "" };
  const { body } = assemblePrContent(partial, change, null);
  // Summary falls back to why; What falls back to the changed-file list; How
  // falls back to the coder's own summary.
  assert.ok(body.includes("Because."));
  assert.ok(body.includes("- `src/queue.ts`"));
  assert.ok(body.includes("Add a per-issue retry budget."));
});

test("Notes is omitted entirely when empty, never left as a bare heading", () => {
  // The one optional section: there is no honest default for "anything else
  // worth knowing", so it is dropped rather than filled.
  const { body } = assemblePrContent({ ...full, notes: "   " }, change, null);
  assert.ok(!body.includes("## Notes"));
  assert.ok(assemblePrContent(full, change, null).body.includes("## Notes"));
});

test("the issue is closed, and only when there is one", () => {
  // A PR that silently omits `Closes #N` leaves the issue open after the work
  // merged — the loop looks broken to whoever filed it.
  assert.ok(assemblePrContent(full, change, null).body.includes("Closes #42"));
  const noIssue = { ...change, issueNumber: null };
  assert.ok(!assemblePrContent(full, noIssue, null).body.includes("Closes #"));
});

test("the requester line appears only when someone asked", () => {
  assert.ok(assemblePrContent(full, change, "valen").body.includes("Requested by: valen"));
  assert.ok(!assemblePrContent(full, change, null).body.includes("Requested by:"));
});

test("the title is trimmed", () => {
  assert.equal(assemblePrContent({ ...full, title: "  spaced  " }, change, null).title, "spaced");
});

test("the fallback body still says what changed and still closes the issue", () => {
  // This is the path taken with no model key, a refusal, or unparseable JSON —
  // mechanical, but it must not be less correct.
  const { title, body } = fallbackPrContent(change, "valen");
  assert.equal(title, "Add a per-issue retry budget.");
  assert.ok(body.includes("- `src/queue.ts`"));
  assert.ok(body.includes("Closes #42"));
  assert.ok(body.includes("Requested by: valen"));
});

test("a long first summary line is NOT used as a title", () => {
  // GitHub does not wrap titles, so a coder summary that opens with a paragraph
  // would otherwise become unreadable. This is why the branch fallback exists.
  const wordy = { ...change, summary: `${"x".repeat(61)}\nmore` };
  assert.equal(buildFallbackTitle(wordy), "Fix issue #42");
  assert.equal(buildFallbackTitle({ ...wordy, issueNumber: null }), "retry budget");
});

test("the branch fallback de-slugs and drops the type prefix", () => {
  const bare = {
    branchName: "feature/add_retry-budget",
    changedFiles: [],
    summary: "",
    issueNumber: null,
  };
  assert.equal(buildFallbackTitle(bare), "add retry budget");
  assert.equal(
    buildFallbackTitle({ ...bare, branchName: "chore/x" }),
    "x",
    "any known type prefix is dropped",
  );
});

test("a branch that de-slugs to nothing still yields a title", () => {
  const odd = { branchName: "fix/", changedFiles: [], summary: "", issueNumber: null };
  assert.equal(buildFallbackTitle(odd), "Code changes on fix/");
});

test("no changed files reads as a sentence, not an empty list", () => {
  assert.equal(changedFilesList([]), "No files changed.");
  assert.equal(changedFilesList(["a.ts"]), "- `a.ts`");
});

test("readString walks a nested path and never throws", () => {
  const obj = { a: { b: { c: "deep" } }, n: 7 };
  assert.equal(readString(obj, "a", "b", "c"), "deep");
  assert.equal(readString(obj, "a", "missing", "c"), null);
  assert.equal(readString(obj, "n"), null, "a non-string is not a string");
  assert.equal(readString(null, "a"), null);
});
