// The repo-context block tells the agent when deps are ALREADY installed (the
// orchestrator preinstall / artifact cache populates node_modules off the agent
// loop), so the coder doesn't waste turns re-running `yarn install`. This covers
// the node_modules detection that drives that signal. Run against dist with
// `node --test`.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installedDepDirs } from "../dist/index.js";

async function scratch() {
  return mkdtemp(path.join(os.tmpdir(), "repo-ctx-deps-"));
}

test("detects node_modules at the repo root (reported as '.')", async () => {
  const dir = await scratch();
  try {
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    assert.deepEqual(installedDepDirs(dir), ["."]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("detects a nested app's node_modules (the frontend/ case)", async () => {
  const dir = await scratch();
  try {
    await mkdir(path.join(dir, "frontend", "node_modules"), { recursive: true });
    assert.deepEqual(installedDepDirs(dir), ["frontend"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports both root and nested when both are installed", async () => {
  const dir = await scratch();
  try {
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    await mkdir(path.join(dir, "frontend", "node_modules"), { recursive: true });
    assert.deepEqual(installedDepDirs(dir).sort(), [".", "frontend"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no node_modules anywhere → empty (agent installs as usual)", async () => {
  const dir = await scratch();
  try {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "package.json"), "{}");
    assert.deepEqual(installedDepDirs(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("does not descend past maxDepth, and skips .git/dotdirs", async () => {
  const dir = await scratch();
  try {
    // depth 3 → not found at default maxDepth 2
    await mkdir(path.join(dir, "a", "b", "c", "node_modules"), { recursive: true });
    // node_modules inside a dotdir is ignored
    await mkdir(path.join(dir, ".cache", "node_modules"), { recursive: true });
    assert.deepEqual(installedDepDirs(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
