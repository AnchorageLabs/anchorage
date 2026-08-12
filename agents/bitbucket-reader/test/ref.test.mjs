// Turning a human-written issue reference into a Bitbucket identifier.
// Dependency-free (node:test), run against the built dist.
//
// Getting this wrong does not fail loudly — it reads the WRONG issue, and the
// coder then implements something nobody asked for.
import assert from "node:assert/strict";
import test from "node:test";
import { parseIssueRef } from "../dist/ref.js";

const repo = { owner: "acme", name: "widgets" };

test("a full Bitbucket issue URL is understood", () => {
  const out = parseIssueRef("https://bitbucket.org/owner/repo/issues/5", null);
  assert.equal(out?.id, 5);
  assert.ok(out?.repo.length > 0);
});

test("an explicit project and number", () => {
  assert.deepEqual(parseIssueRef("other/thing#42", repo), { repo: "other/thing", id: 42 });
});

test("a bare number resolves against the run's repository", () => {
  assert.deepEqual(parseIssueRef("42", repo), { repo: "acme/widgets", id: 42 });
});

test("#42 is accepted — it used to be REJECTED while 42 worked", () => {
  // The most natural way to write an issue reference. The old pattern required at
  // least one character before the "#", so an orchestrator or a person writing
  // the obvious thing got "could not parse the reference" instead of the issue.
  assert.deepEqual(parseIssueRef("#42", repo), { repo: "acme/widgets", id: 42 });
});

test("whitespace around the reference is tolerated", () => {
  assert.deepEqual(parseIssueRef("  #42  ", repo), { repo: "acme/widgets", id: 42 });
});

test("a bare number with NO repository is refused, not guessed", () => {
  // There is nothing it could mean, and reading an arbitrary project's issue 42
  // would be worse than failing.
  assert.equal(parseIssueRef("42", null), null);
  assert.equal(parseIssueRef("#42", undefined), null);
});

test("an explicit project still works with no repository in the envelope", () => {
  assert.deepEqual(parseIssueRef("other/thing#42", null), { repo: "other/thing", id: 42 });
});

test("unparseable references return null rather than a guess", () => {
  for (const value of [
    "",
    "   ",
    "abc",
    "12a",
    "issue 42",
    "#",
    "##42",
    null,
    undefined,
    42,
    {},
    [],
  ]) {
    assert.equal(parseIssueRef(value, repo), null, `value: ${JSON.stringify(value)}`);
  }
});

test("parsing is deterministic", () => {
  assert.deepEqual(parseIssueRef("#42", repo), parseIssueRef("#42", repo));
});
