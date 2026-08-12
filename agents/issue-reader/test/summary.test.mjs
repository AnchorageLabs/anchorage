// Turning a GitHub issue into the issue.summary artifact. Dependency-free
// (node:test), run against the built dist.
//
// Every downstream agent plans, codes and reviews from this shape, so a field that
// arrives as null where a string was expected does not fail here — it fails two
// agents later, far from the cause.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLabels, toIssueSummary } from "../dist/summary.js";

const repo = { owner: "acme", name: "widgets" };

const issue = {
  number: 42,
  title: "Retries never stop",
  state: "open",
  body: "It loops forever.",
  html_url: "https://github.com/acme/widgets/issues/42",
  user: { login: "valen" },
  labels: [{ name: "bug" }, { name: "p1" }],
};

test("the full mapping", () => {
  assert.deepEqual(toIssueSummary(issue, repo), {
    issueNumber: 42,
    title: "Retries never stop",
    repository: "acme/widgets",
    state: "open",
    labels: ["bug", "p1"],
    body: "It loops forever.",
    url: "https://github.com/acme/widgets/issues/42",
    author: "valen",
  });
});

test("labels arrive as bare strings OR objects, sometimes in the same array", () => {
  // The shape depends on how the label was attached, and GitHub mixes them.
  assert.deepEqual(normalizeLabels(["bug", { name: "p1" }, "chore"]), ["bug", "p1", "chore"]);
});

test("a label with no usable name is DROPPED, not passed on as null", () => {
  // A downstream `labels.includes(...)` would otherwise compare against a hole.
  assert.deepEqual(normalizeLabels([{ name: null }, { name: "" }, {}, { name: "real" }]), ["real"]);
  for (const label of normalizeLabels([{ name: null }, "ok"])) {
    assert.equal(typeof label, "string");
  }
});

test("an empty label array stays empty", () => {
  assert.deepEqual(normalizeLabels([]), []);
  assert.deepEqual(toIssueSummary({ ...issue, labels: [] }, repo).labels, []);
});

test("a null body becomes an empty string, so no consumer needs its own null check", () => {
  // An issue with no description is ordinary.
  assert.equal(toIssueSummary({ ...issue, body: null }, repo).body, "");
  assert.equal(toIssueSummary({ ...issue, body: undefined }, repo).body, "");
});

test("a deleted author stays NULL rather than being invented", () => {
  // A deleted account genuinely has no login; substituting one would be a false
  // fact travelling in an artifact.
  assert.equal(toIssueSummary({ ...issue, user: null }, repo).author, null);
  assert.equal(toIssueSummary({ ...issue, user: undefined }, repo).author, null);
});

test("the repository is the run's, not the issue's URL", () => {
  // The artifact names where the work happens, which is the run's repository —
  // deriving it from html_url would break for a transferred issue.
  const transferred = { ...issue, html_url: "https://github.com/other/place/issues/42" };
  assert.equal(toIssueSummary(transferred, repo).repository, "acme/widgets");
});

test("a closed issue is mapped, not refused — the warning is the caller's job", () => {
  assert.equal(toIssueSummary({ ...issue, state: "closed" }, repo).state, "closed");
});

test("every field has a defined type on the way out", () => {
  const bare = {
    number: 1,
    title: "",
    state: "open",
    html_url: "u",
    labels: [],
  };
  const out = toIssueSummary(bare, repo);
  assert.equal(typeof out.issueNumber, "number");
  assert.equal(typeof out.title, "string");
  assert.equal(typeof out.body, "string");
  assert.equal(typeof out.url, "string");
  assert.ok(Array.isArray(out.labels));
  assert.ok(out.author === null || typeof out.author === "string");
});

test("mapping is deterministic", () => {
  assert.deepEqual(toIssueSummary(issue, repo), toIssueSummary(issue, repo));
});
