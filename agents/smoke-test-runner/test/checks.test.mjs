// Reading the smoke-check list. Dependency-free (node:test), run against the built
// dist.
//
// The danger here is not a crash, it is a QUIET PASS. Malformed entries used to be
// skipped silently, so a list of five checks with four mistakes ran ONE check and
// the report said `passed` — a smoke test that skipped most of its checks and
// reported success, which is exactly the false reassurance a smoke test exists to
// refuse to give.
import assert from "node:assert/strict";
import test from "node:test";
import { parseCheckSpecs } from "../dist/checks.js";

test("a well-formed list parses whole", () => {
  const { checks, skipped } = parseCheckSpecs([
    { type: "http", name: "home", url: "https://x/", expectedStatus: 204 },
    { type: "shell", name: "migrate", command: "npm", args: ["run", "migrate"] },
  ]);
  assert.equal(skipped.length, 0);
  assert.deepEqual(checks[0], {
    type: "http",
    name: "home",
    url: "https://x/",
    expectedStatus: 204,
  });
  assert.deepEqual(checks[1], {
    type: "shell",
    name: "migrate",
    command: "npm",
    args: ["run", "migrate"],
  });
});

test("EVERY dropped entry is reported, with its index and a reason", () => {
  // The whole point. Four bad entries out of five must not vanish.
  const { checks, skipped } = parseCheckSpecs([
    { type: "http", url: "https://ok/" },
    { type: "http", name: "no-url" },
    { type: "shell", name: "no-command" },
    { type: "telepathy", name: "wrong-type" },
    "not an object",
  ]);
  assert.equal(checks.length, 1);
  assert.equal(skipped.length, 4);
  assert.deepEqual(
    skipped.map((s) => s.index),
    [1, 2, 3, 4],
    "the index points at the caller's array position — a malformed entry often has no usable name",
  );
  assert.match(skipped[0].reason, /no url/);
  assert.match(skipped[1].reason, /no command/);
  assert.match(skipped[2].reason, /telepathy/);
  assert.match(skipped[3].reason, /not an object/);
});

test("a missing type is named as missing, not as unknown", () => {
  const { skipped } = parseCheckSpecs([{ name: "typeless" }]);
  assert.match(skipped[0].reason, /missing check type/);
});

test("expectedStatus defaults to 200, and a non-number does not become NaN", () => {
  const { checks } = parseCheckSpecs([
    { type: "http", url: "https://a/" },
    { type: "http", url: "https://b/", expectedStatus: "201" },
    { type: "http", url: "https://c/", expectedStatus: Number.NaN },
  ]);
  for (const check of checks) assert.equal(check.expectedStatus, 200);
});

test("non-string args are filtered rather than passed to a shell", () => {
  const { checks } = parseCheckSpecs([
    { type: "shell", command: "echo", args: ["ok", 7, null, { a: 1 }, "also-ok"] },
  ]);
  assert.deepEqual(checks[0].args, ["ok", "also-ok"]);
});

test("a missing args list becomes an empty one, never undefined", () => {
  const { checks } = parseCheckSpecs([{ type: "shell", command: "echo" }]);
  assert.deepEqual(checks[0].args, []);
});

test("an unnamed check gets a stable positional name", () => {
  const { checks } = parseCheckSpecs([
    { type: "http", url: "https://a/" },
    { type: "http", url: "https://b/" },
  ]);
  assert.deepEqual(
    checks.map((c) => c.name),
    ["check_1", "check_2"],
  );
});

test("a non-array input yields nothing and claims nothing", () => {
  for (const value of [undefined, null, {}, "checks", 7]) {
    const { checks, skipped } = parseCheckSpecs(value);
    assert.deepEqual(checks, [], String(value));
    assert.deepEqual(skipped, [], String(value));
  }
});

test("parsing is deterministic", () => {
  const input = [{ type: "http", url: "https://a/" }, { type: "nope" }];
  assert.deepEqual(parseCheckSpecs(input), parseCheckSpecs(input));
});
