// Parsing the coder's final report. Dependency-free (node:test), run against
// the built dist with `node --test`, matching issue-triage/test/comment.test.mjs.
//
// The coder is the highest-churn file in the whole agents tree — 77 commits,
// 3,812 lines changed, 4 authors — and had no tests, because nothing in that
// 1,600-line script was exported. These pin the behaviour that shipped bugs:
// a truncated reply must not read as "the model said nothing", and prose or
// fences around the JSON must not lose the report.
import assert from "node:assert/strict";
import test from "node:test";
import { parseCoderSummary } from "../dist/summary.js";

const report = {
  summary: "Added a retry budget to the queue consumer.",
  commandsSuggested: ["npm test"],
  risks: ["retries can mask a permanent failure"],
};

test("parses a bare JSON report", () => {
  const out = parseCoderSummary(JSON.stringify(report));
  assert.deepEqual(out, report);
});

test("finds the report inside prose and a fenced block", () => {
  const text = [
    "I looked at the consumer and made the change.",
    "```json",
    JSON.stringify(report),
    "```",
    "Let me know if you want the budget configurable.",
  ].join("\n");
  assert.deepEqual(parseCoderSummary(text), report);
});

test("ignores a <thinking> block, including one containing braces", () => {
  const text = [
    "<thinking>",
    'maybe return { summary: "wrong one" } — no, decided against it',
    "</thinking>",
    JSON.stringify(report),
  ].join("\n");
  assert.equal(parseCoderSummary(text).summary, report.summary);
});

test("braces inside string values do not end the object early", () => {
  // The scan tracks string state and escapes; a naive brace count would stop at
  // the `}` inside the value and fail to parse.
  const tricky = { summary: 'handles a literal } and a "quote"', commandsSuggested: [], risks: [] };
  assert.deepEqual(parseCoderSummary(JSON.stringify(tricky)), tricky);
});

test("a nested object does not confuse the scan", () => {
  const nested = { summary: "ok", commandsSuggested: [], risks: [], extra: { a: { b: 1 } } };
  const out = parseCoderSummary(JSON.stringify(nested));
  assert.equal(out.summary, "ok");
});

test("a TRUNCATED reply still reports what the model said, never silence", () => {
  // The failure this guards is #209: a length-truncated turn was reported as an
  // empty "no changes", which reads as "the model did nothing" — the opposite of
  // what happened. Unparseable must degrade to the prose, not to nothing.
  const cut = `I rewrote the consumer and added the budget. {"summary": "Added a retry bud`;
  const out = parseCoderSummary(cut);
  assert.ok(out.summary.length > 0, "summary must not be empty on a truncated reply");
  assert.ok(out.summary.includes("rewrote the consumer"));
  assert.deepEqual(out.commandsSuggested, []);
  assert.deepEqual(out.risks, []);
});

test("prose with no JSON at all falls back to the first 800 characters", () => {
  const prose = `x${"y".repeat(1200)}`;
  const out = parseCoderSummary(prose);
  assert.equal(out.summary.length, 800);
  assert.ok(prose.startsWith(out.summary));
});

test("wrong types are dropped rather than trusted", () => {
  // The model is not a schema. A non-string summary falls back; non-string list
  // entries are filtered out instead of reaching the artifact.
  const out = parseCoderSummary(
    JSON.stringify({ summary: 42, commandsSuggested: ["ok", 7, "", null], risks: "not an array" }),
  );
  assert.equal(typeof out.summary, "string");
  assert.deepEqual(out.commandsSuggested, ["ok"]);
  assert.deepEqual(out.risks, []);
});

test("an object wrapped in an array is still found", () => {
  // The scan looks for the first balanced OBJECT anywhere in the text, so an
  // array wrapper does not hide the report — same reason prose and fences do
  // not. Documented because it is a deliberate consequence of the scan, not an
  // accident: a top-level array is rejected by `isObject`, but an object inside
  // one is exactly the "JSON somewhere in the reply" case.
  const out = parseCoderSummary('[{"summary": "in an array", "risks": ["r"]}]');
  assert.equal(out.summary, "in an array");
  assert.deepEqual(out.risks, ["r"]);
});

test("never throws, whatever arrives", () => {
  for (const input of ["", "{", "}", "{{{{", '{"a":', "null", "undefined", "{}"]) {
    assert.doesNotThrow(() => parseCoderSummary(input), `input: ${JSON.stringify(input)}`);
  }
});
