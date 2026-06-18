// Master switch for the persisted-index tool surface. ANCHORAGE_INDEX_TOOLS_ENABLED=false
// must drop all seven index tools from the catalog (a clean "no index" baseline),
// while the lexical tools (read_file/grep/git_*) remain. The flag is read at module
// load, so each case spawns a fresh node process with the env set. Run with `node --test`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const distIndex = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/index.js",
);

const INDEX_TOOLS = [
  "find_references",
  "symbol_outline",
  "impact",
  "tests_for",
  "repo_map",
  "locate_change",
  "relevant_tests",
];

// Spawn a fresh node that imports the built catalog under a given env and prints
// the repoReadTools names — the flag is evaluated at import, so a child is the
// only faithful way to assert it.
function readToolNames(env) {
  const script = `import("${distIndex}").then(m => { process.stdout.write(JSON.stringify(m.repoReadTools.map(t => t.name))); });`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

test("default (flag unset): all seven index tools are offered", () => {
  const names = readToolNames({ ANCHORAGE_INDEX_TOOLS_ENABLED: "" });
  for (const t of INDEX_TOOLS) assert.ok(names.includes(t), `${t} should be present by default`);
});

test("flag off: every index tool is dropped, lexical tools remain", () => {
  const names = readToolNames({ ANCHORAGE_INDEX_TOOLS_ENABLED: "false" });
  for (const t of INDEX_TOOLS) assert.ok(!names.includes(t), `${t} should be gone when off`);
  for (const t of ["read_file", "grep", "git_log", "list_dir"]) {
    assert.ok(names.includes(t), `${t} (lexical) should remain`);
  }
});

test("flag accepts on/off spellings", () => {
  assert.ok(readToolNames({ ANCHORAGE_INDEX_TOOLS_ENABLED: "0" }).includes("repo_map") === false);
  assert.ok(readToolNames({ ANCHORAGE_INDEX_TOOLS_ENABLED: "off" }).includes("impact") === false);
  assert.ok(readToolNames({ ANCHORAGE_INDEX_TOOLS_ENABLED: "true" }).includes("impact") === true);
});
