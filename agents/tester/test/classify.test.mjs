// Telling "the tests failed" apart from "the environment could not run them".
// Dependency-free (node:test), run against the built dist.
//
// Getting this wrong is expensive in both directions: environment noise reported
// as a code failure burns a retry AND hands the coder a "fix this" instruction
// about code that was never broken; a real failure reported as blocked lets
// broken code proceed toward merge. So the rule is narrow on purpose.
import assert from "node:assert/strict";
import test from "node:test";
import { classifyEnvironment } from "../dist/classify.js";

const out = (exitCode, stderr = "", stdout = "") => ({ exitCode, stderr, stdout });

test("a passing command is never blocked, whatever it printed", () => {
  // Success is success. Plenty of test suites print "connection refused" while
  // exercising a retry path and still pass.
  assert.deepEqual(classifyEnvironment(out(0, "connection refused")), { blocked: false });
});

test("a plain test failure stays a test failure", () => {
  // THE important negative. If this drifted to blocked, real breakage would stop
  // failing runs.
  assert.deepEqual(classifyEnvironment(out(1, "2 tests failed\nexpected 3 got 4")), {
    blocked: false,
  });
  assert.deepEqual(classifyEnvironment(out(1, "AssertionError: values differ")), {
    blocked: false,
  });
});

test("exit 127 is always the environment — nothing was tested", () => {
  const verdict = classifyEnvironment(out(127, "some-tool: missing"));
  assert.equal(verdict.blocked, true);
  assert.match(verdict.reason, /127/);
});

test("both streams are searched, because tools disagree about which to use", () => {
  assert.equal(classifyEnvironment(out(1, "command not found", "")).blocked, true);
  assert.equal(classifyEnvironment(out(1, "", "command not found")).blocked, true);
});

test("a Docker failure reports DOCKER, not a generic missing command", () => {
  // BEHAVIOUR CHANGE, deliberate. In the original order the generic
  // `: not found` pattern sat first and shadowed this one, so
  // "docker: command not found" reported "a required command is not installed" —
  // true but useless, since the fix is provisioning Docker in the worker, not
  // installing a package. The specific patterns now precede the generic one.
  const verdict = classifyEnvironment(out(1, "docker: command not found"));
  assert.equal(verdict.blocked, true);
  assert.match(verdict.reason, /Docker/);

  assert.match(classifyEnvironment(out(1, "Cannot connect to the Docker daemon")).reason, /Docker/);
});

test("Make and Gradle failures keep their own reasons", () => {
  assert.match(classifyEnvironment(out(2, "make: *** [test] Error 127")).reason, /Make target/);
  assert.match(
    classifyEnvironment(out(1, "./gradlew: permission denied")).reason,
    /Gradle wrapper/,
  );
});

test("an unreachable service is the environment, not the code", () => {
  for (const text of [
    "Error: connect ECONNREFUSED 127.0.0.1:5432",
    "could not connect to server",
    "could not translate host name",
  ]) {
    assert.equal(classifyEnvironment(out(1, text)).blocked, true, text);
  }
});

test("a toolchain version skew is the worker's problem, not the repo's", () => {
  // A repo pinning a newer toolchain than the worker has cannot be built here,
  // and that is not a defect in the repo — treating it as a test failure would
  // send the coder chasing a manifest it should not change.
  const cases = [
    ["go: go.mod requires go >= 1.25.0", /Go toolchain/],
    ["error invalid go version '1.25.x'", /Go toolchain/],
    ["npm ERR! code EBADENGINE unsupported engine", /runtime version/],
    ["Unsupported class file major version 65", /JDK version/],
    ["Error: JAVA_HOME is not set", /JDK version/],
  ];
  for (const [text, expected] of cases) {
    const verdict = classifyEnvironment(out(1, text));
    assert.equal(verdict.blocked, true, text);
    assert.match(verdict.reason, expected, text);
  }
});

test("a missing file is the environment", () => {
  assert.equal(
    classifyEnvironment(out(1, "bash: ./scripts/test.sh: No such file or directory")).blocked,
    true,
  );
});

test("empty output with a non-zero exit is a test failure, not a guess", () => {
  // No evidence of an environment problem means we do not invent one. Calling an
  // unexplained failure "blocked" would silently stop failing runs.
  assert.deepEqual(classifyEnvironment(out(1)), { blocked: false });
});
