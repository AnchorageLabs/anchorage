// shell_exec must reject backgrounding a process. `npm run dev &` (and friends)
// hand control back to bash immediately while the detached child holds the
// stdio pipes open, so the tool's `close` never fires and the run freezes
// forever with no tool.result. We detect and refuse these up front; the
// process-group kill on timeout (not unit-tested here — needs a real spawn) is
// the backstop for any long-lived command that slips through.
import assert from "node:assert/strict";
import test from "node:test";
import { backgroundsAProcess, startsLongRunningServer } from "../dist/tools/builtin/shell.js";

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

test("startsLongRunningServer flags foreground dev/preview servers (no &)", () => {
  for (const cmd of [
    "npm run dev",
    "yarn dev",
    "pnpm run start",
    "pnpm start",
    "vite",
    "vite dev",
    "vite serve",
    "vite preview",
    "next dev",
    "nuxt dev",
    "astro dev",
    "ng serve",
    "react-scripts start",
    "npx vite",
    "pnpm dlx serve dist",
    "vitest",
    "vitest watch",
    "cd frontend/.anchorage/preview && npm run dev",
    "PORT=3101 npm run dev",
  ]) {
    assert.equal(startsLongRunningServer(cmd), true, `should flag: ${cmd}`);
  }
});

test("startsLongRunningServer does NOT flag finite commands", () => {
  for (const cmd of [
    "npm install",
    "npm install --no-workspaces --include=dev",
    "npm run build",
    "vite build",
    "next build",
    "astro build",
    "vite --version",
    "vitest run",
    "npx tsc --noEmit",
    "node --version",
    "ls -la",
    "cat package.json",
    "cd app && npm ci",
  ]) {
    assert.equal(startsLongRunningServer(cmd), false, `should NOT flag: ${cmd}`);
  }
});
