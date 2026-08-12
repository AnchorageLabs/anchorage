// The runner's `--help`. Dependency-free (node:test), run against the built dist
// by spawning the real binary — the only way to assert an exit code.
//
// This existed as a CI "smoke test" for three months written as
// `node dist/index.js --help || true`. The `|| true` was load-bearing: the runner
// had no `--help`, so it printed usage and exited 2. Every wrapper that shells
// out and asks for help saw a failure, and the smoke test could not detect
// anything at all.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const run = async (args) => {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
};

test("--help exits 0 — asking for help is not an error", async () => {
  const { code } = await run(["--help"]);
  assert.equal(code, 0);
});

test("-h and help are accepted too", async () => {
  for (const flag of ["-h", "help"]) {
    assert.equal((await run([flag])).code, 0, flag);
  }
});

test("help goes to STDOUT, so it can be piped", async () => {
  // Usage-as-a-correction belongs on stderr; usage-as-an-answer belongs on
  // stdout, or `anchorage-runner --help | less` prints nothing and a wrapper
  // capturing stderr mistakes help for a diagnostic.
  const { stdout, stderr } = await run(["--help"]);
  assert.match(stdout, /Usage: anchorage-runner run/);
  assert.equal(stderr, "");
});

test("it names the run command and the help flag", async () => {
  const { stdout } = await run(["--help"]);
  assert.match(stdout, /run <agent>/);
  assert.match(stdout, /--help/);
});

test("a WRONG invocation still exits non-zero, with usage on stderr", async () => {
  // The distinction that makes the above meaningful: help is a success, a
  // mistake is not, and they must not be the same exit code.
  const missingAgent = await run(["run"]);
  assert.notEqual(missingAgent.code, 0);
  assert.match(missingAgent.stderr, /Usage: anchorage-runner run/);

  const unknown = await run(["nonsense"]);
  assert.notEqual(unknown.code, 0);
});
