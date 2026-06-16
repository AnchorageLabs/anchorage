// Tests for the persisted symbol/import index (store.ts): a cold build from
// `git ls-files` + tree-sitter, blast-radius queries (definitions, transitive
// dependents, covering tests), and the content-hash incremental refresh — both
// the whole-tree refresh() and the single-file refreshFile() the mid-run reindex
// uses. Dependency-free (node:test), run against the built dist with `node --test`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IndexStore, clearIndexStore, isTestPath } from "../dist/tools/symbols/store.js";

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

// A tiny git repo: a util defining `compute`, a consumer importing it, and a
// test mirroring the consumer's name. Mirrors the real dependency shapes the
// store must resolve.
async function makeRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "anc-idx-"));
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
  return root;
}

test("cold build indexes definitions, references and the import graph", async () => {
  const root = await makeRepo();
  clearIndexStore(root);
  const store = await IndexStore.open(root);
  assert.ok(store, "store should build");
  assert.equal(store.fileCount, 3);

  const defs = store.definitionsOf("compute");
  assert.equal(defs.length, 1);
  assert.equal(defs[0].file, "src/util.ts");
  assert.equal(defs[0].kind, "function");

  // util.ts is imported by consumer.ts, and consumer.ts by consumer.test.ts —
  // so both carry in-degree 1; consumer.test.ts (imported by nothing) is 0.
  const ranking = store.inDegreeRanking();
  const byFile = Object.fromEntries(ranking.map((r) => [r.file, r.inDegree]));
  assert.equal(byFile["src/util.ts"], 1);
  assert.equal(byFile["src/consumer.ts"], 1);
  assert.equal(byFile["test/consumer.test.ts"], 0);

  await rm(root, { recursive: true, force: true });
});

test("impact resolves transitive dependents and covering tests", async () => {
  const root = await makeRepo();
  clearIndexStore(root);
  const store = await IndexStore.open(root);

  const im = store.impact("compute");
  assert.equal(im.definitions.length, 1);
  // consumer.ts imports util.ts; consumer.test.ts imports consumer.ts →
  // both are transitive dependents of util.ts.
  assert.ok(im.dependents.includes("src/consumer.ts"));
  assert.ok(im.dependents.includes("test/consumer.test.ts"));
  // the test file is surfaced as a covering test.
  assert.ok(im.tests.includes("test/consumer.test.ts"));

  await rm(root, { recursive: true, force: true });
});

test("refresh re-analyzes only changed files (content hash)", async () => {
  const root = await makeRepo();
  clearIndexStore(root);
  const store = await IndexStore.open(root);
  assert.equal(store.definitionsOf("compute2").length, 0);

  // Add a new definition to util.ts and re-run the whole-tree refresh.
  await writeFile(
    path.join(root, "src", "util.ts"),
    "export function compute(a, b) {\n  return a + b;\n}\nexport function compute2(a) {\n  return a;\n}\n",
  );
  await store.refresh();
  assert.equal(store.definitionsOf("compute2").length, 1);
  assert.equal(store.definitionsOf("compute2")[0].file, "src/util.ts");

  await rm(root, { recursive: true, force: true });
});

test("refreshFile picks up a single mid-run edit", async () => {
  const root = await makeRepo();
  clearIndexStore(root);
  const store = await IndexStore.open(root);

  await writeFile(
    path.join(root, "src", "util.ts"),
    "export function compute(a, b) {\n  return a + b;\n}\nexport class Widget {}\n",
  );
  await store.refreshFile("src/util.ts");
  const defs = store.definitionsOf("Widget");
  assert.equal(defs.length, 1);
  assert.equal(defs[0].kind, "class");

  await rm(root, { recursive: true, force: true });
});

test("isTestPath recognizes common test layouts", () => {
  assert.ok(isTestPath("test/foo.test.ts"));
  assert.ok(isTestPath("src/__tests__/foo.ts"));
  assert.ok(isTestPath("pkg/foo_test.go"));
  assert.ok(isTestPath("spec/foo.spec.js"));
  assert.equal(isTestPath("src/foo.ts"), false);
});
