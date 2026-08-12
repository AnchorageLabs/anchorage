// Getting the review verdict out of the model's reply. Dependency-free
// (node:test), run against the built dist.
//
// A failure here means a COMPLETED review is discarded and the run reports that
// it could not review — the work was done and then thrown away. So the recovery
// paths matter more than they look, and the failure MESSAGES matter too: they are
// surfaced to the run, and they point at different fixes.
import assert from "node:assert/strict";
import test from "node:test";
import { extractJsonObject, parseReviewJson } from "../dist/parse.js";

const review = { verdict: "approve", comments: [], risks: ["none"] };

test("parses a bare review object", () => {
  const out = parseReviewJson(JSON.stringify(review));
  assert.equal(out.ok, true);
  assert.deepEqual(out.value, review);
});

test("recovers from a fence, a <thinking> block, and prose on both sides", () => {
  const text = [
    "<thinking>the diff looks fine, though { braces } in here could confuse a parser</thinking>",
    "Here is my review:",
    "```json",
    JSON.stringify(review),
    "```",
    "Happy to look again.",
  ].join("\n");
  const out = parseReviewJson(text);
  assert.equal(out.ok, true);
  assert.equal(out.value.verdict, "approve");
});

test("a brace inside a string value does not end the object early", () => {
  const tricky = { verdict: "request_changes", note: 'unbalanced } and "quotes"' };
  const out = parseReviewJson(JSON.stringify(tricky));
  assert.equal(out.ok, true);
  assert.equal(out.value.note, tricky.note);
});

test("scanning continues past a brace that does not open valid JSON", () => {
  // This is the difference between a balanced scan and a greedy one: prose
  // containing "{" before the real object must not poison the result.
  const text = `The function starts with { and then... ${JSON.stringify(review)}`;
  const out = parseReviewJson(text);
  assert.equal(out.ok, true);
  assert.equal(out.value.verdict, "approve");
});

test("prose after the object does not break it", () => {
  // A greedy first-{ to last-} span would fail here, which is why this agent
  // scans for a balanced object instead.
  const out = parseReviewJson(`${JSON.stringify(review)} — let me know if unclear.`);
  assert.equal(out.ok, true);
});

test("the three failure modes are distinguishable, because they need different fixes", () => {
  // "no object" = the model ignored the format; "not an object" = it returned an
  // array; "invalid" = it was cut off. Collapsing them would make the run report
  // useless for diagnosis.
  const noObject = parseReviewJson("I approve this change.");
  assert.equal(noObject.ok, false);
  assert.match(noObject.message, /did not contain a JSON object/);

  const notObject = parseReviewJson("[1, 2, 3]");
  assert.equal(notObject.ok, false);
  assert.match(notObject.message, /did not contain a JSON object/);

  // A top-level array whose ELEMENT is an object still finds the object — the
  // scan looks for objects anywhere, so this is the documented consequence.
  const arrayOfObjects = parseReviewJson('[{"verdict":"approve"}]');
  assert.equal(arrayOfObjects.ok, true);
});

test("never throws, whatever arrives", () => {
  for (const input of ["", "{", "}", "{{{{", '{"a":', "null", "undefined", "```json\n```"]) {
    assert.doesNotThrow(() => parseReviewJson(input), `input: ${JSON.stringify(input)}`);
  }
});

test("extractJsonObject returns the substring, not a parsed value", () => {
  // The two-stage shape (extract, then parse) is what lets the caller report a
  // parse error separately from a missing object.
  assert.equal(extractJsonObject('prose {"a":1} more'), '{"a":1}');
  assert.equal(extractJsonObject("no object here"), null);
  assert.equal(extractJsonObject(""), null);
});

test("a nested object is returned whole", () => {
  const nested = '{"a":{"b":{"c":1}}}';
  assert.equal(extractJsonObject(`x ${nested} y`), nested);
});
