// Integration tests for cross-repo context: the read tools resolve the optional
// `repo` argument to a read-only context root, writes always target the primary,
// and the envelope→mount + prompt helpers behave. Dependency-free (node:test),
// run against the built dist with `node --test`.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  contextRepoPromptBlock,
  contextReposFromEnvelope,
  repoReadTools,
  repoWriteTools,
} from "../dist/index.js";
import { createBudgetState } from "../dist/tools/budget.js";

const readFileTool = repoReadTools.find((t) => t.name === "read_file");
const writeFileTool = repoWriteTools.find((t) => t.name === "write_file");

function makeCtx(primary, mounts) {
  return {
    workspacePath: primary,
    contextRepos: mounts,
    capabilities: new Set(["repo.read", "workspace.write"]),
    env: {},
    budget: createBudgetState(),
    emit: () => {},
    log: () => {},
  };
}

async function tmp(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("read_file: primary by default, context via repo:, isolation enforced", async () => {
  const primary = await tmp("anc-prim-");
  const ctxRoot = await tmp("anc-ctx-");
  await writeFile(path.join(primary, "a.txt"), "PRIMARY-BODY");
  await writeFile(path.join(ctxRoot, "b.txt"), "CONTEXT-BODY");
  const ctx = makeCtx(primary, [{ ref: "org/ctx", root: ctxRoot }]);

  // No repo arg → primary.
  const r1 = await readFileTool.handler({ path: "a.txt" }, ctx);
  assert.equal(r1.ok, true);
  assert.match(r1.output, /PRIMARY-BODY/);

  // repo arg → context root, labelled with the ref.
  const r2 = await readFileTool.handler({ path: "b.txt", repo: "org/ctx" }, ctx);
  assert.equal(r2.ok, true);
  assert.match(r2.output, /CONTEXT-BODY/);
  assert.match(r2.output, /org\/ctx:b\.txt/);

  // Unknown repo → fails with the available list, not a silent fallback.
  const r3 = await readFileTool.handler({ path: "b.txt", repo: "org/nope" }, ctx);
  assert.equal(r3.ok, false);
  assert.equal(r3.code, "unknown_repo");

  // Traversal out of a context root is still rejected.
  const r4 = await readFileTool.handler({ path: "../escape", repo: "org/ctx" }, ctx);
  assert.equal(r4.ok, false);

  await rm(primary, { recursive: true, force: true });
  await rm(ctxRoot, { recursive: true, force: true });
});

test("write_file always targets the primary, never a context repo", async () => {
  const primary = await tmp("anc-prim-");
  const ctxRoot = await tmp("anc-ctx-");
  const ctx = makeCtx(primary, [{ ref: "org/ctx", root: ctxRoot }]);

  // Even if a repo arg is smuggled in, write goes to the primary.
  const w = await writeFileTool.handler({ path: "c.txt", content: "X", repo: "org/ctx" }, ctx);
  assert.equal(w.ok, true);
  assert.equal(await readFile(path.join(primary, "c.txt"), "utf8"), "X");
  await assert.rejects(readFile(path.join(ctxRoot, "c.txt"), "utf8"));

  await rm(primary, { recursive: true, force: true });
  await rm(ctxRoot, { recursive: true, force: true });
});

test("contextReposFromEnvelope maps owner/name and drops malformed entries", () => {
  const mounts = contextReposFromEnvelope([
    { owner: "Org", name: "lib", root: "/r/lib", note: "shared types" },
    { owner: "Org", name: "ui", root: "/r/ui" },
    { owner: "Org", root: "/bad" }, // missing name → dropped
    { name: "x", root: "/bad" }, // missing owner → dropped
  ]);
  assert.equal(mounts.length, 2);
  assert.deepEqual(mounts[0], { ref: "Org/lib", root: "/r/lib", note: "shared types" });
  assert.deepEqual(mounts[1], { ref: "Org/ui", root: "/r/ui" });
  assert.deepEqual(contextReposFromEnvelope(undefined), []);
});

test("contextRepoPromptBlock is empty for none and lists repos otherwise", () => {
  assert.equal(contextRepoPromptBlock(undefined), "");
  assert.equal(contextRepoPromptBlock([]), "");
  const block = contextRepoPromptBlock([{ ref: "Org/lib", root: "/r", note: "why" }]);
  assert.match(block, /Org\/lib — why/);
  assert.match(block, /read-only/i);
  assert.match(block, /CANNOT write/);
});
