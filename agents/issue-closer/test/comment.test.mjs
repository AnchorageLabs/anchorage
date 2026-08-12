// The closing comment on the issue. Dependency-free (node:test), run against the
// built dist.
//
// Whoever filed the issue may see nothing else about the work — not the PR
// description, not the test report, not the run view. This comment is the index
// into everything the run produced, so a dropped link is evidence nobody will go
// looking for.
import assert from "node:assert/strict";
import test from "node:test";
import { buildComment, formatValue } from "../dist/comment.js";

const empty = {
  summary: null,
  prUrl: null,
  commitSha: null,
  testReportUri: null,
  ciReportUri: null,
  deploymentUri: null,
  smokeTestUri: null,
  artifacts: [],
};

const full = {
  ...empty,
  summary: "Added a per-issue retry budget.",
  prUrl: "https://github.com/o/r/pull/7",
  commitSha: "a1b2c3d",
  testReportUri: "file:///tmp/test-report.json",
  artifacts: ["file:///tmp/issue-closed.json"],
};

test("every provided link appears, with its label", () => {
  const out = buildComment(full);
  assert.ok(out.includes("- Pull request: https://github.com/o/r/pull/7"));
  assert.ok(out.includes("- Commit: `a1b2c3d`"));
  assert.ok(out.includes("- Test report: `file:///tmp/test-report.json`"));
});

test("a URL stays clickable; anything else is code-quoted", () => {
  // A commit sha or a file:// path would otherwise be mangled by markdown, or
  // rendered as a link that goes nowhere.
  assert.equal(formatValue("https://example.com/x"), "https://example.com/x");
  assert.equal(formatValue("a1b2c3d"), "`a1b2c3d`");
  assert.equal(formatValue("file:///tmp/x.json"), "`file:///tmp/x.json`");
});

test("absent links are dropped, not rendered as empty rows", () => {
  const out = buildComment(full);
  // ciReportUri, deploymentUri and smokeTestUri were null.
  assert.ok(!out.includes("- CI report:"));
  assert.ok(!out.includes("- Deployment:"));
  assert.ok(!out.includes("- Smoke test:"));
  assert.ok(!/- \w[\w ]*: *$/m.test(out), "no label may be left with nothing after it");
});

test("an empty-string link is treated as absent", () => {
  const out = buildComment({ ...empty, prUrl: "", commitSha: "   " });
  assert.ok(!out.includes("- Pull request:"));
  // A whitespace-only value is not filtered by the length check, so it renders
  // quoted rather than as a bare label — still not an empty row.
  assert.ok(!/- Pull request: *$/m.test(out));
});

test("a section with no entries is omitted whole, never a bare heading", () => {
  // A heading with nothing under it reads as "the run produced nothing here",
  // which is a different and usually false claim.
  const out = buildComment(empty);
  assert.ok(!out.includes("## Links"));
  assert.ok(!out.includes("## Artifacts"));
  assert.ok(buildComment(full).includes("## Links"));
  assert.ok(buildComment(full).includes("## Artifacts"));
});

test("a run with no summary still says it finished", () => {
  assert.ok(buildComment(empty).includes("Workflow completed successfully."));
  assert.ok(buildComment(full).includes("Added a per-issue retry budget."));
});

test("the comment is always well-formed and attributed", () => {
  for (const input of [empty, full]) {
    const out = buildComment(input);
    assert.ok(out.startsWith("## Anchorage Run Summary"));
    assert.ok(
      out.trimEnd().endsWith("agent.*"),
      "the attribution footer always closes it, so a reader knows what wrote it",
    );
  }
});

test("rendering is deterministic and link order is stable", () => {
  assert.equal(buildComment(full), buildComment(full));
  const out = buildComment(full);
  assert.ok(
    out.indexOf("- Pull request:") < out.indexOf("- Commit:"),
    "the most useful link comes first",
  );
});

test("every artifact is listed", () => {
  const many = { ...empty, artifacts: ["file:///a.json", "https://x/b", "c.txt"] };
  const out = buildComment(many);
  assert.ok(out.includes("- `file:///a.json`"));
  assert.ok(out.includes("- https://x/b"));
  assert.ok(out.includes("- `c.txt`"));
});
