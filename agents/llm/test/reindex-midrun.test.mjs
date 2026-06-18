// B4: after the coder writes/edits/deletes a file mid-run, the persisted index
// is kept in sync so the very next impact / find_references call sees the change
// — with no explicit reindex step. Also asserts the bounded-build guarantee: a
// write before anything has queried the index does NOT trigger a cold build.
// Run against the built dist with `node --test`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { repoReadTools, repoWriteTools } from "../dist/index.js";
import { createBudgetState } from "../dist/tools/budget.js";
import { clearIndexStore, peekIndexStore } from "../dist/tools/symbols/store.js";

const impact = repoReadTools.find((t) => t.name === "impact");
const locateChange = repoReadTools.find((t) => t.name === "locate_change");
const writeFileTool = repoWriteTools.find((t) => t.name === "write_file");
const editFileTool = repoWriteTools.find((t) => t.name === "edit_file");

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function ctxFor(root) {
  return {
    workspacePath: root,
    capabilities: new Set(["repo.read", "workspace.write"]),
    env: {},
    budget: createBudgetState(),
    emit: () => {},
    log: () => {},
  };
}

async function makeRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "anc-rdx-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "util.ts"),
    "export function compute(a, b) {\n  return a + b;\n}\n",
  );
  git(root, "init");
  git(root, "add", "-A");
  clearIndexStore(root);
  return root;
}

test("a write before any query does not trigger a cold index build", async () => {
  const root = await makeRepo();
  const ctx = ctxFor(root);
  // No read tool has run yet → no index cached.
  assert.equal(peekIndexStore(root), null);
  await writeFileTool.handler(
    { path: "src/extra.ts", content: "export function helper() {}\n" },
    ctx,
  );
  // The write must NOT have built an index (bounded-build guarantee).
  assert.equal(peekIndexStore(root), null);
  await rm(root, { recursive: true, force: true });
});

test("edit_file mid-run is visible to the next impact call", async () => {
  const root = await makeRepo();
  const ctx = ctxFor(root);

  // Warm the index via a read tool.
  const before = await impact.handler({ symbol: "Widget" }, ctx);
  assert.equal(before.meta.index, false, "Widget should not exist yet");
  assert.notEqual(peekIndexStore(root), null, "index should be built after a read");

  // Coder adds a new class via edit_file.
  await editFileTool.handler(
    {
      path: "src/util.ts",
      old_string: "export function compute(a, b) {\n  return a + b;\n}\n",
      new_string: "export function compute(a, b) {\n  return a + b;\n}\nexport class Widget {}\n",
    },
    ctx,
  );

  // Next impact call sees it — no explicit reindex.
  const after = await impact.handler({ symbol: "Widget" }, ctx);
  assert.equal(after.meta.index, true);
  assert.equal(after.meta.definitions, 1);
  assert.match(after.output, /src\/util\.ts:\d+\s+class Widget/);

  await rm(root, { recursive: true, force: true });
});

test("write_file of a new file is visible to locate_change", async () => {
  const root = await makeRepo();
  const ctx = ctxFor(root);
  await impact.handler({ symbol: "compute" }, ctx); // warm

  await writeFileTool.handler(
    { path: "src/new-mod.ts", content: "export function brandNew() {\n  return 1;\n}\n" },
    ctx,
  );
  const res = await locateChange.handler({ symbol: "brandNew" }, ctx);
  assert.equal(res.meta.index, true);
  assert.equal(res.meta.definitions, 1);
  assert.match(res.output, /src\/new-mod\.ts/);

  await rm(root, { recursive: true, force: true });
});
