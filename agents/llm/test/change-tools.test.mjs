// Tests for the edit-oriented index tools (change-tools.ts): locate_change
// returns definition + direct-referencing files for a symbol, and relevant_tests
// returns the deduped union of covering tests for a set of changed paths. Run
// against the built dist with `node --test`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { repoReadTools } from "../dist/index.js";
import { createBudgetState } from "../dist/tools/budget.js";
import { clearIndexStore } from "../dist/tools/symbols/store.js";

const locateChange = repoReadTools.find((t) => t.name === "locate_change");
const relevantTests = repoReadTools.find((t) => t.name === "relevant_tests");

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function ctxFor(root) {
  return {
    workspacePath: root,
    capabilities: new Set(["repo.read"]),
    env: {},
    budget: createBudgetState(),
    emit: () => {},
    log: () => {},
  };
}

async function makeRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "anc-chg-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(
    path.join(root, "src", "util.ts"),
    "export function compute(a, b) {\n  return a + b;\n}\n",
  );
  await writeFile(
    path.join(root, "src", "consumer.ts"),
    "import { compute } from './util.js';\nexport function run() {\n  return compute(1, 2);\n}\n",
  );
  await writeFile(
    path.join(root, "test", "consumer.test.ts"),
    "import { run } from '../src/consumer.js';\nrun();\n",
  );
  git(root, "init");
  git(root, "add", "-A");
  clearIndexStore(root);
  return root;
}

test("locate_change returns the definition and direct referencing files", async () => {
  const root = await makeRepo();
  const res = await locateChange.handler({ symbol: "compute" }, ctxFor(root));
  assert.equal(res.ok, true);
  assert.equal(res.meta.index, true);
  assert.equal(res.meta.definitions, 1);
  assert.match(res.output, /src\/util\.ts:1\s+function compute/);
  // consumer.ts references compute; it's listed, the def file isn't duplicated.
  assert.match(res.output, /referenced in \(1\):/);
  assert.match(res.output, /src\/consumer\.ts/);
  await rm(root, { recursive: true, force: true });
});

test("locate_change validates the symbol and fails closed off-index", async () => {
  const root = await makeRepo();
  const bad = await locateChange.handler({ symbol: "a b c" }, ctxFor(root));
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "invalid_input");
  const missing = await locateChange.handler({ symbol: "nonexistentSym" }, ctxFor(root));
  assert.equal(missing.ok, true);
  assert.equal(missing.meta.index, false);
  await rm(root, { recursive: true, force: true });
});

test("relevant_tests unions covering tests across changed paths", async () => {
  const root = await makeRepo();
  const res = await relevantTests.handler(
    { paths: ["src/util.ts", "src/consumer.ts"] },
    ctxFor(root),
  );
  assert.equal(res.ok, true);
  assert.ok(res.output.includes("test/consumer.test.ts"));
  assert.equal(res.meta.inputs, 2);
  await rm(root, { recursive: true, force: true });
});

test("relevant_tests requires a non-empty paths array", async () => {
  const root = await makeRepo();
  const res = await relevantTests.handler({ paths: [] }, ctxFor(root));
  assert.equal(res.ok, false);
  assert.equal(res.code, "invalid_input");
  await rm(root, { recursive: true, force: true });
});
