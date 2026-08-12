// The issue text this agent actually files. Dependency-free (node:test), run
// against the built dist.
//
// Whatever comes out of here becomes a real GitHub issue that a human reads and a
// planner plans from. Both failure directions matter: a malformed model reply must
// not open an empty or half-written issue, and a fallback must not silently lose
// what the user asked for.
import assert from "node:assert/strict";
import test from "node:test";
import { fallbackDraft, MAX_FALLBACK_TITLE, parseIssueDraft } from "../dist/draft.js";

test("a complete draft parses, trimmed", () => {
  const out = parseIssueDraft(
    JSON.stringify({ title: "  Add a retry budget  ", body: "  Because.  ", labels: ["bug"] }),
  );
  assert.deepEqual(out, { title: "Add a retry budget", body: "Because.", labels: ["bug"] });
});

test("prose, fences and <thinking> around the JSON no longer lose the draft", () => {
  // This file held the FOURTH copy of the JSON scan, and its greedy variant lost
  // the whole draft whenever anything surrounded the object.
  const good = JSON.stringify({ title: "T", body: "B" });
  for (const reply of [
    `<thinking>maybe {a:1}</thinking>${good}`,
    `${good} note: use { braces } with care`,
    `starts with { then ${good}`,
    "```json\n" + good + "\n```",
  ]) {
    assert.equal(parseIssueDraft(reply)?.title, "T", reply.slice(0, 40));
  }
});

test("a missing or blank title or body is REFUSED, not filed", () => {
  // An issue with a blank title or an empty body is worse than the mechanical
  // fallback: it looks like a real issue and carries nothing. Returning null is
  // what routes the caller to fallbackDraft.
  for (const draft of [
    { body: "B" },
    { title: "T" },
    { title: "", body: "B" },
    { title: "T", body: "" },
    { title: "   ", body: "B" },
    { title: "T", body: "   " },
    { title: 7, body: "B" },
  ]) {
    assert.equal(parseIssueDraft(JSON.stringify(draft)), null, JSON.stringify(draft));
  }
});

test("labels are filtered to non-empty strings, never passed through raw", () => {
  const out = parseIssueDraft(
    JSON.stringify({ title: "T", body: "B", labels: ["bug", "", 7, null, "ok"] }),
  );
  assert.deepEqual(out.labels, ["bug", "ok"]);
});

test("a missing labels list becomes empty, never undefined", () => {
  assert.deepEqual(parseIssueDraft(JSON.stringify({ title: "T", body: "B" })).labels, []);
});

test("never throws, whatever the model returned", () => {
  for (const input of ["", "{", "}", "not json", "null", "[]", "{{{"]) {
    assert.doesNotThrow(() => parseIssueDraft(input), JSON.stringify(input));
  }
});

test("the fallback keeps the instruction VERBATIM", () => {
  // The one thing that definitely came from the user must survive even when
  // everything else failed.
  const instruction = "Fix the login redirect.\n\nIt loops on Safari with `?next=` set.";
  const { body } = fallbackDraft(instruction);
  assert.ok(body.includes(instruction), "the whole instruction, unaltered");
});

test("the fallback SAYS exploration did not complete", () => {
  // So a reader knows the issue is thinner than usual, rather than assuming the
  // agent had nothing to say.
  assert.match(fallbackDraft("x").body, /full repository exploration was not completed/);
});

test("the fallback title is the first meaningful line, with markdown heading marks stripped", () => {
  assert.equal(fallbackDraft("## Fix the login\n\nmore").title, "Fix the login");
  assert.equal(fallbackDraft("\n\n   \nFix it\nlater").title, "Fix it");
});

test("a long title is truncated with an ellipsis, because GitHub does not wrap them", () => {
  const long = "y".repeat(200);
  const { title } = fallbackDraft(long);
  assert.equal(title.length, MAX_FALLBACK_TITLE - 2, "77 chars plus the single-char ellipsis");
  assert.ok(title.endsWith("…"));
  assert.ok(title.length < long.length);
});

test("a title exactly at the limit is NOT truncated", () => {
  const exact = "z".repeat(MAX_FALLBACK_TITLE);
  assert.equal(fallbackDraft(exact).title, exact);
});

test("an empty instruction still yields a usable title", () => {
  for (const instruction of ["", "\n\n", "   "]) {
    assert.equal(fallbackDraft(instruction).title, "Automated change request");
  }
});

test("the fallback always carries acceptance criteria a reviewer can check", () => {
  const { body } = fallbackDraft("do the thing");
  assert.match(body, /## Acceptance criteria/);
  assert.match(body, /- \[ \]/);
});
