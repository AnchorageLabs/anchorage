// get_artifact (Fase 3 · D2) — the escape hatch for the context budget. Reads a
// prior artifact's full content from its file:// URI on demand, bounded, and
// fails closed (a short note, never an error) when absent/unreadable. Run
// against the built dist with `node --test`.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { getArtifactTool } from "../dist/index.js";
import { createBudgetState } from "../dist/tools/budget.js";

function ctxWith(artifacts) {
  return {
    workspacePath: process.cwd(),
    artifacts,
    capabilities: new Set(["repo.read"]),
    env: {},
    budget: createBudgetState(),
    emit: () => {},
    log: () => {},
  };
}

async function artifactFile(dir, name, content) {
  const file = path.join(dir, name);
  await writeFile(file, content, "utf8");
  return pathToFileURL(file).href;
}

test("fetches the full content of an available artifact", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "anc-art-"));
  const uri = await artifactFile(dir, "issue.json", JSON.stringify({ title: "Bug", body: "details" }));
  const res = await getArtifactTool.handler(
    { artifactType: "issue.summary" },
    ctxWith([{ artifactType: "issue.summary", uri }]),
  );
  assert.equal(res.ok, true);
  assert.equal(res.meta.found, true);
  assert.match(res.output, /=== artifact: issue\.summary ===/);
  assert.match(res.output, /details/);
  await rm(dir, { recursive: true, force: true });
});

test("most-recent same-type artifact wins", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "anc-art-"));
  const oldUri = await artifactFile(dir, "old.json", "OLD");
  const newUri = await artifactFile(dir, "new.json", "NEW");
  const res = await getArtifactTool.handler(
    { artifactType: "code.revision.request" },
    ctxWith([
      { artifactType: "code.revision.request", uri: oldUri },
      { artifactType: "code.revision.request", uri: newUri },
    ]),
  );
  assert.match(res.output, /NEW/);
  assert.ok(!/OLD/.test(res.output));
  await rm(dir, { recursive: true, force: true });
});

test("truncates content past the per-fetch cap", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "anc-art-"));
  const big = "x".repeat(30_000);
  const uri = await artifactFile(dir, "big.json", big);
  const res = await getArtifactTool.handler(
    { artifactType: "issue.summary" },
    ctxWith([{ artifactType: "issue.summary", uri }]),
  );
  assert.equal(res.meta.truncated, true);
  assert.match(res.output, /\[truncated \d+ of 30000 bytes\]/);
  await rm(dir, { recursive: true, force: true });
});

test("fails closed (note, not error) when the artifact is absent", async () => {
  const res = await getArtifactTool.handler(
    { artifactType: "implementation.plan" },
    ctxWith([{ artifactType: "issue.summary", uri: "file:///nope.json" }]),
  );
  assert.equal(res.ok, true);
  assert.equal(res.meta.found, false);
  assert.match(res.output, /No 'implementation\.plan' artifact available/);
  assert.match(res.output, /Available: issue\.summary/);
});

test("missing artifactType is an input error listing what is available", async () => {
  const res = await getArtifactTool.handler({}, ctxWith([{ artifactType: "issue.summary", uri: "file:///x" }]));
  assert.equal(res.ok, false);
  assert.equal(res.code, "invalid_input");
  assert.match(res.message, /Available: issue\.summary/);
});

test("non-file uri fails closed", async () => {
  const res = await getArtifactTool.handler(
    { artifactType: "issue.summary" },
    ctxWith([{ artifactType: "issue.summary", uri: "https://example.com/x.json" }]),
  );
  assert.equal(res.meta.found, false);
  assert.match(res.output, /not a local file/);
});
