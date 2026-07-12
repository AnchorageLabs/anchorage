// Tests for the graph-first grep redirect: with ANCHORAGE_GRAPH_FIRST_GUARD=1,
// a grep whose pattern is a bare symbol is answered FROM the symbol index (the
// find_references result returned in the grep tool_result slot — zero extra
// turns), and falls back to the real grep when the index has no answer. It must
// NEVER refuse: refusals sent models into grep-variant retry spirals (370
// refused calls in one field run). Run against the built dist.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { repoReadTools } from "../dist/index.js";
import { createBudgetState } from "../dist/tools/budget.js";
import { clearIndexStore } from "../dist/tools/symbols/store.js";

const grep = repoReadTools.find((t) => t.name === "grep");

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function ctxFor(root, env = {}) {
  return {
    workspacePath: root,
    capabilities: new Set(["repo.read"]),
    env,
    budget: createBudgetState(),
    emit: () => {},
    log: () => {},
  };
}

async function makeRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "anc-gfg-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "util.ts"),
    "export function computeTotal(a, b) {\n  return a + b;\n}\n",
  );
  await writeFile(
    path.join(root, "src", "consumer.ts"),
    "import { computeTotal } from './util.js';\nexport const x = computeTotal(1, 2);\n",
  );
  git(root, "init");
  git(root, "add", "-A");
  clearIndexStore(root);
  return root;
}

const GUARD_ON = { ANCHORAGE_GRAPH_FIRST_GUARD: "1" };

test("symbol grep with guard on is served from the index in the same result (no refusal)", async () => {
  const root = await makeRepo();
  const res = await grep.handler({ pattern: "computeTotal" }, ctxFor(root, GUARD_ON));

  assert.equal(res.ok, true, "never a refusal");
  assert.equal(res.meta.viaSymbolIndex, true);
  assert.match(res.output, /resolved via symbol index/);
  assert.match(res.output, /find_references: computeTotal/);
  assert.match(res.output, /src\/util\.ts/, "definition site present");
  assert.match(res.output, /src\/consumer\.ts/, "reference site present");
});

test("symbol grep falls back to the real grep when the index has no answer", async () => {
  const root = await makeRepo();
  // camelCase (symbol-shaped) but not present in the index.
  const res = await grep.handler({ pattern: "doesNotExistAnywhere" }, ctxFor(root, GUARD_ON));

  assert.equal(res.ok, true, "fallback grep runs — never a refusal");
  assert.equal(res.meta.viaSymbolIndex, undefined);
  assert.match(res.output, /no matches for/);
});

test("free-form patterns bypass the graph entirely even with guard on", async () => {
  const root = await makeRepo();
  const res = await grep.handler({ pattern: "return a" }, ctxFor(root, GUARD_ON));
  assert.equal(res.ok, true);
  assert.equal(res.meta.viaSymbolIndex, undefined);
  assert.match(res.output, /util\.ts/);
});

test("guard off: symbol grep is a plain substring grep (unchanged behavior)", async () => {
  const root = await makeRepo();
  const res = await grep.handler({ pattern: "computeTotal" }, ctxFor(root, {}));
  assert.equal(res.ok, true);
  assert.equal(res.meta.viaSymbolIndex, undefined);
  assert.match(res.output, /grep \/computeTotal\//);
});

test("qualified pattern resolves its last segment against the index", async () => {
  const root = await makeRepo();
  const res = await grep.handler({ pattern: "Util.computeTotal" }, ctxFor(root, GUARD_ON));
  assert.equal(res.ok, true);
  // Served from the index for the member identifier.
  assert.equal(res.meta.viaSymbolIndex, true);
  assert.match(res.output, /find_references: computeTotal/);
});
