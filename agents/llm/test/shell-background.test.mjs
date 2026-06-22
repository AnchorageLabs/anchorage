// shell_exec must reject backgrounding a process. `npm run dev &` (and friends)
// hand control back to bash immediately while the detached child holds the
// stdio pipes open, so the tool's `close` never fires and the run freezes
// forever with no tool.result. We detect and refuse these up front; the
// process-group kill on timeout (not unit-tested here — needs a real spawn) is
// the backstop for any long-lived command that slips through.
import assert from "node:assert/strict";
import test from "node:test";
import { backgroundsAProcess } from "../dist/tools/builtin/shell.js";

test("backgroundsAProcess flags background / daemon commands", () => {
  for (const cmd of [
    "npm run dev &",
    "npm run dev&",
    "nohup node server.js",
    "node server.js & echo started",
    "(sleep 100 &)",
    "disown",
    "python -m http.server 8000 &",
  ]) {
    assert.equal(backgroundsAProcess(cmd), true, `should flag: ${cmd}`);
  }
});

test("backgroundsAProcess does NOT flag legitimate commands with & in redirects/operators", () => {
  for (const cmd of [
    "npm run build",
    "pytest 2>&1 | tail -40",
    "make 2>&1",
    "echo hi >&2",
    "node build.js &>build.log", // redirect, not backgrounding — but &> would be flagged?
    "test -f a && npm test",
    "a=1 && b=2 && echo $a$b",
    "grep -r 'foo && bar' src",
  ]) {
    assert.equal(backgroundsAProcess(cmd), false, `should NOT flag: ${cmd}`);
  }
});
