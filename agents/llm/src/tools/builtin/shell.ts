import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { checkShellBudget, recordShell } from "../budget.js";
import type { JsonObject, ToolContext, ToolDefinition, ToolHandlerResult } from "../types.js";
import { cleanTerminalOutput, shellCleanEnabled } from "./output-clean.js";

// Lockfile → the package manager that owns it. Order matters: the first lockfile
// found wins when several are (wrongly) present.
const LOCKFILE_PM: ReadonlyArray<readonly [string, "pnpm" | "yarn" | "bun" | "npm"]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];
// Subcommands that READ or WRITE the lockfile / install deps — running these
// under the wrong manager forks a second lockfile and corrupts the dep tree.
const PM_MUTATING_SUBCOMMANDS = new Set([
  "install",
  "i",
  "ci",
  "add",
  "remove",
  "rm",
  "uninstall",
  "update",
  "up",
  "upgrade",
  "dedupe",
  "prune",
]);
const NODE_PMS = new Set(["npm", "yarn", "pnpm", "bun"]);

/** The package manager a directory's lockfile commits it to, or null if none. */
function lockfilePackageManager(dir: string): string | null {
  for (const [lock, pm] of LOCKFILE_PM) {
    if (existsSync(path.join(dir, lock))) return pm;
  }
  return null;
}

/**
 * Refuse a node package-manager command that contradicts the repo's lockfile —
 * e.g. `npm install` in a repo whose dep tree is owned by `yarn.lock`. Running
 * the wrong manager forks a second lockfile (the chary/teramot-aleph PRs that
 * shipped both yarn.lock and package-lock.json) and can rewrite package.json.
 * Returns a guidance message to block on, or null to allow.
 *
 * Detection is deliberately conservative: it only fires on a dep-mutating
 * subcommand of a node PM whose owner lockfile names a *different* manager, and
 * resolves the lockfile from the command's effective directory (an optional
 * leading `cd <dir> &&`), then cwd, then the workspace root.
 */
function packageManagerGuard(
  commandText: string,
  cwd: string,
  workspacePath: string,
): string | null {
  // Effective dir: honor a leading `cd <dir> &&` / `cd <dir>;` so a command run
  // from the repo root against a sub-package is checked against that package.
  let effectiveDir = cwd;
  const cd = commandText.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;)/);
  const cdTarget = cd?.[1] ?? cd?.[2] ?? cd?.[3];
  if (cdTarget) effectiveDir = path.resolve(cwd, cdTarget);

  const pmCall = commandText.match(/(?:^|&&|\||;|\()\s*(npm|yarn|pnpm|bun)\s+([a-z]+)/i);
  if (!pmCall) return null;
  const usedPm = (pmCall[1] ?? "").toLowerCase();
  const sub = (pmCall[2] ?? "").toLowerCase();
  if (!NODE_PMS.has(usedPm) || !PM_MUTATING_SUBCOMMANDS.has(sub)) return null;

  const canonical =
    lockfilePackageManager(effectiveDir) ??
    lockfilePackageManager(cwd) ??
    lockfilePackageManager(workspacePath);
  if (!canonical || canonical === usedPm) return null;

  return (
    `shell_exec: refusing \`${usedPm} ${sub}\` — this repo's dependencies are managed by ` +
    `${canonical} (its lockfile is present). Running ${usedPm} would create a conflicting ` +
    `${usedPm} lockfile and may rewrite package.json. Use \`${canonical}\` instead ` +
    `(e.g. \`${canonical} ${sub === "i" ? "install" : sub}\`).`
  );
}

// Test-runner launchers the coder must never invoke: the coder's job is to make
// the change; the downstream tester step runs the change's COVERING tests
// (scoped to the touched files). Letting the coder run tests drives it to
// bootstrap a missing test framework (yarn add vitest …) and thrash.
const TEST_RUNNER_BINARIES = new Set([
  "vitest",
  "jest",
  "mocha",
  "pytest",
  "py.test",
  "ava",
  "tap",
  "tape",
  "jasmine",
  "karma",
]);

/**
 * Coder-scoped policy: refuse the two command classes that make the coder
 * thrash for tens of minutes — installing/adding dependencies (incl.
 * bootstrapping a test framework the repo lacks) and deleting node_modules — and
 * running the test suite (the tester step owns that). Gated on
 * ANCHORAGE_CODER_SHELL_GUARD=1, which only the coder sets, so the tester and
 * other agents that legitimately install/test are unaffected. Scoped typecheck /
 * build commands (tsc, go build, …) are deliberately still allowed.
 */
function coderShellPolicyGuard(commandText: string, env: Record<string, string>): string | null {
  if (env.ANCHORAGE_CODER_SHELL_GUARD !== "1") return null;

  // Deleting node_modules — the coder nuking the preinstalled tree to force a
  // clean reinstall. The single worst loop trigger.
  if (/\brm\b[^\n]*\bnode_modules\b/.test(commandText)) {
    return (
      "shell_exec: refusing to delete node_modules — dependencies are preinstalled before the coder " +
      "runs. Do NOT reinstall; make your code change and finish. The tester step verifies."
    );
  }

  // Node package-manager install/add/upgrade, or a `<pm> test` / `<pm> run test`.
  const pm = commandText.match(/(?:^|&&|\||;|\()\s*(npm|yarn|pnpm|bun)\s+([a-z-]+)/i);
  if (pm) {
    const sub = (pm[2] ?? "").toLowerCase();
    if (PM_MUTATING_SUBCOMMANDS.has(sub)) {
      return (
        "shell_exec: refusing to install/add dependencies — deps are already installed before you " +
        "start, and adding packages (e.g. bootstrapping a test framework the repo lacks) is not the " +
        "coder's job. Edit the code (and package.json if the task needs a new dep) and finish; the " +
        "tester step runs the change's covering tests."
      );
    }
    if (sub === "test" || /\brun\s+test\b/.test(commandText)) {
      return (
        "shell_exec: the coder does not run the test suite — the downstream tester step runs the " +
        "change's covering tests, scoped to the files you touched. Make your change and finish."
      );
    }
  }

  // pip install.
  if (/\bpip3?\s+install\b/.test(commandText)) {
    return (
      "shell_exec: refusing pip install — dependencies are preinstalled and installing is not the " +
      "coder's job. Make your change and finish; the tester verifies."
    );
  }

  // Direct / npx test-runner binaries, and `go test` / `cargo test` / `node --test`.
  const segments = commandText.split(/&&|\|\||[;|]/);
  const last = (segments[segments.length - 1] ?? "").trim();
  const tokens = last.split(/\s+/).filter((t) => t.length > 0);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")) i += 1;
  let bin = path.basename(tokens[i] ?? "");
  if (bin === "npx") {
    i += 1;
    bin = path.basename(tokens[i] ?? "");
  }
  const testRunner =
    TEST_RUNNER_BINARIES.has(bin) ||
    (bin === "go" && (tokens[i + 1] ?? "").toLowerCase() === "test") ||
    (bin === "cargo" && (tokens[i + 1] ?? "").toLowerCase() === "test") ||
    (bin === "node" && tokens.includes("--test"));
  if (testRunner) {
    return (
      "shell_exec: the coder does not run tests — the tester step runs the change's covering tests. " +
      "Make your change and finish (a scoped typecheck/build like `tsc --noEmit -p …` or `go build` is fine)."
    );
  }
  return null;
}

// Env names that must never reach the spawned shell. Adding to this list is
// always safe; removing is a security decision and warrants review.
const SECRET_ENV_NAMES = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "MOONSHOT_API_KEY",
  "KIMI_API_KEY",
  "ANCHORAGE_LLM_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "TEMPORAL_API_KEY",
  // GH_TOKEN/GITHUB_TOKEN intentionally omitted: scrubbed below by default but
  // can be re-enabled via ANCHORAGE_SHELL_ENV_PASSTHROUGH for runs that need
  // `gh` CLI. Scrub by default to limit blast radius.
]);

// Default safe env. Everything else is dropped.
const DEFAULT_ENV_ALLOW = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TZ",
  "TERM",
  "PWD",
  "NODE_ENV",
  "CI",
  "TMPDIR",
]);

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_STDOUT_BYTES = 100_000;
const MAX_STDERR_BYTES = 16_000;

interface ShellInvocation {
  argv: string[];
  cwd: string;
  envSnapshot: Record<string, string>;
  timeoutMs: number;
}

function resolveCwd(workspace: string, requested: unknown): null | string {
  if (typeof requested !== "string" || requested.trim().length === 0) return workspace;
  const normalized = requested.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized) return workspace;
  if (normalized.includes("..")) return null;
  const abs = path.resolve(workspace, normalized);
  const rel = path.relative(workspace, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return abs;
}

/**
 * Does the command start a background / detached / daemon process? Such a
 * command (e.g. `npm run dev &`) returns control to bash immediately, but the
 * backgrounded child inherits and holds the stdout/stderr pipes open — so the
 * tool's `close` never fires and the run freezes forever waiting on a result.
 * Long-lived servers belong in the preview/runtime step, not shell_exec.
 *
 * Detection strips the `&` forms that are NOT backgrounding (the `&&` operator
 * and `&`-bearing redirections like `2>&1`, `>&2`, `&>file`), then treats any
 * remaining bare `&` as a background operator. `nohup`/`disown` are explicit.
 */
export function backgroundsAProcess(command: string): boolean {
  if (/\b(nohup|disown)\b/.test(command)) return true;
  const stripped = command
    .replace(/\d*>&\d*/g, " ") // 2>&1, >&2, >&-
    .replace(/&>>?/g, " ") // &>file, &>>file
    .replace(/&&/g, " "); // logical AND
  return /&/.test(stripped);
}

// Dev-server / watcher launchers that run in the FOREGROUND and never exit.
// Unlike a backgrounded job these have no `&`, so they pass backgroundsAProcess —
// but they still never return, so shell_exec blocks until the timeout fires and
// the model, seeing no result, retries: minutes of apparent "freeze". A preview
// server belongs in the runtime/preview step (the caller starts it detached),
// never in shell_exec. We refuse them up front so the model gets an instant,
// actionable error instead of a timeout. Finite sibling commands of the same
// tools (`vite build`, `next build`, `astro build`) are explicitly allowed.
const DEV_SERVER_SUBCOMMANDS = new Set(["dev", "serve", "preview", "start", "develop", "watch"]);
const FINITE_BUILD_SUBCOMMANDS = new Set(["build", "generate", "export", "optimize", "check"]);
// Query flags that make even a dev-server binary finite (`vite --version`).
const FINITE_QUERY_FLAGS = new Set(["--version", "-v", "--help", "-h", "--info"]);
// Binaries that ARE a server when run with no/dev subcommand.
const DEV_SERVER_BINARIES = new Set([
  "vite",
  "next",
  "nuxt",
  "astro",
  "remix",
  "gatsby",
  "ng", // angular
  "vue-cli-service",
  "react-scripts",
  "webpack-dev-server",
  "webpack-serve",
  "serve",
  "http-server",
  "live-server",
  "nodemon",
  "vitest", // `vitest` w/o `run` is watch mode
]);

/**
 * Does the command start a long-running dev/preview server or watcher that won't
 * exit on its own? Matches `<pm> run dev|start|serve|preview`, `<pm> dev|start`,
 * `npx <devserver>`, and bare dev-server binaries — while allowing their finite
 * `build`/`generate`/`run` forms. Conservative: inspects only the LAST simple
 * command in a `cd x && …` / `… | …` chain (the one that actually runs).
 */
export function startsLongRunningServer(command: string): boolean {
  // The launcher is the last segment of a `cd … && …` / pipe / sequence chain.
  const segments = command.split(/&&|\|\||[;|]/);
  const last = segments[segments.length - 1]?.trim() ?? "";
  // Drop leading VAR=val env assignments, then tokenize.
  const tokens = last.split(/\s+/).filter((t) => t.length > 0);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")) i += 1;
  if (i >= tokens.length) return false;

  let bin = path.basename(tokens[i] ?? "");

  // `npx <bin>` / `pnpm dlx <bin>` / `yarn dlx <bin>`: unwrap to the real binary.
  if (bin === "npx") {
    i += 1;
  } else if (NODE_PMS.has(bin) && (tokens[i + 1] === "dlx" || tokens[i + 1] === "exec")) {
    i += 2;
  } else if (NODE_PMS.has(bin)) {
    // `<pm> run <script>` or `<pm> <script>`.
    let j = i + 1;
    if (tokens[j] === "run") j += 1;
    const sub = (tokens[j] ?? "").toLowerCase();
    if (FINITE_BUILD_SUBCOMMANDS.has(sub)) return false;
    return DEV_SERVER_SUBCOMMANDS.has(sub);
  }
  bin = path.basename(tokens[i] ?? "");
  if (!DEV_SERVER_BINARIES.has(bin)) return false;

  const sub = (tokens[i + 1] ?? "").toLowerCase();
  if (FINITE_BUILD_SUBCOMMANDS.has(sub) || FINITE_QUERY_FLAGS.has(sub)) return false;
  // `vitest run` is finite; bare `vitest` is watch mode.
  if (bin === "vitest") return sub !== "run";
  return true;
}

function buildArgv(
  command: unknown,
): { ok: true; argv: string[] } | { ok: false; message: string } {
  // String form runs through bash with pipefail so the model can use pipes,
  // redirects, and shell expansion without hiding failures before `| tail`.
  if (typeof command === "string") {
    const trimmed = command.trim();
    if (!trimmed) return { ok: false, message: "shell_exec: command string is empty." };
    if (backgroundsAProcess(trimmed)) {
      return {
        ok: false,
        message:
          "shell_exec: backgrounding a process (`&` / `nohup` / `disown`) is not supported — " +
          "it leaves a long-lived process that never returns a result and freezes the run. " +
          "Run finite commands only; start a dev/preview server through the preview/runtime " +
          "step, not shell_exec.",
      };
    }
    if (startsLongRunningServer(trimmed)) {
      return {
        ok: false,
        message:
          "shell_exec: refusing to start a long-running dev/preview server (e.g. `npm run dev`, " +
          "`vite`, `next dev`) — it never exits, so this call would block until timeout and the " +
          "run appears frozen. You do NOT need to start it: write the harness files and finish by " +
          "calling submit_preview with the install + start commands; the caller starts the server " +
          "and reports back. Use shell_exec only for finite checks (install, build, --version).",
      };
    }
    return { ok: true, argv: ["bash", "--noprofile", "--norc", "-o", "pipefail", "-c", trimmed] };
  }
  // Argv form runs the program directly — safer when the model can structure
  // its own argv but offers no pipes/redirects.
  if (Array.isArray(command)) {
    const argv = command.filter((entry): entry is string => typeof entry === "string");
    if (argv.length !== command.length) {
      return { ok: false, message: "shell_exec: argv entries must all be strings." };
    }
    if (argv.length === 0) {
      return { ok: false, message: "shell_exec: argv is empty." };
    }
    return { ok: true, argv };
  }
  return { ok: false, message: "shell_exec: command must be a string or array of strings." };
}

function buildEnv(ctxEnv: Record<string, string>): Record<string, string> {
  const passthrough = (process.env.ANCHORAGE_SHELL_ENV_PASSTHROUGH ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const allowed = new Set([...DEFAULT_ENV_ALLOW, ...passthrough]);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(ctxEnv)) {
    if (SECRET_ENV_NAMES.has(name)) continue;
    if (!allowed.has(name) && !name.startsWith("ANCHORAGE_")) continue;
    if (typeof value === "string") out[name] = value;
  }
  // Anchorage agents may legitimately need their own env (model overrides,
  // artifact dir, etc.) — preserved by the ANCHORAGE_ prefix allowlist above.
  // PATH safety: prepend nothing, trust the inherited PATH.
  return out;
}

async function shellExecHandler(input: JsonObject, ctx: ToolContext): Promise<ToolHandlerResult> {
  const budgetCheck = checkShellBudget(ctx.budget);
  if (!budgetCheck.ok) {
    return {
      ok: false,
      code: "budget_exceeded",
      message: budgetCheck.message ?? "Shell budget exceeded.",
    };
  }

  const cwd = resolveCwd(ctx.workspacePath, input.cwd);
  if (cwd === null) {
    return {
      ok: false,
      code: "path_outside_workspace",
      message: `Refusing to run shell with cwd outside workspace: ${String(input.cwd)}`,
    };
  }

  const built = buildArgv(input.command);
  if (!built.ok) {
    return { ok: false, code: "invalid_input", message: built.message };
  }

  // Guard against running the wrong node package manager (npm in a yarn repo,
  // etc.), which forks a second lockfile and can rewrite package.json.
  const commandText =
    typeof input.command === "string" ? input.command : (built.argv ?? []).join(" ");
  const pmMismatch = packageManagerGuard(commandText, cwd, ctx.workspacePath);
  if (pmMismatch) {
    return { ok: false, code: "package_manager_mismatch", message: pmMismatch };
  }

  // Coder-scoped: refuse dependency installs, node_modules deletion, and test
  // runs (the tester owns tests). No-op for every other agent.
  const coderBlock = coderShellPolicyGuard(commandText, ctx.env);
  if (coderBlock) {
    return { ok: false, code: "coder_policy", message: coderBlock };
  }

  const timeoutMs =
    typeof input.timeout_ms === "number" && input.timeout_ms > 0
      ? Math.min(Math.floor(input.timeout_ms), 600_000)
      : DEFAULT_TIMEOUT_MS;

  const invocation: ShellInvocation = {
    argv: built.argv,
    cwd,
    envSnapshot: buildEnv(ctx.env),
    timeoutMs,
  };

  const result = await spawnBounded(invocation);

  // Budget accounting tracks the RAW bytes the command actually produced.
  recordShell(ctx.budget, result.stdout.length + result.stderr.length);

  // Strip terminal control noise (ANSI, CR progress frames, blank-line runs)
  // before the output reaches the model — lossless, and a large saving on
  // installer/test/build logs. Gated by ANCHORAGE_SHELL_CLEAN (default on).
  const clean = shellCleanEnabled(ctx.env);
  const stdout = cleanTerminalOutput(result.stdout, clean);
  const stderr = cleanTerminalOutput(result.stderr, clean);

  const printableCommand =
    typeof input.command === "string" ? input.command : (input.command as string[]).join(" ");

  const body =
    `=== shell_exec exit=${result.exitCode}${result.timedOut ? " (timed out)" : ""} ===\n` +
    `$ ${printableCommand}\n` +
    (stdout.length > 0 ? `--- stdout ---\n${stdout}\n` : "") +
    (stderr.length > 0 ? `--- stderr ---\n${stderr}\n` : "") +
    (stdout.length === 0 && stderr.length === 0 ? "(no output)\n" : "");

  return {
    ok: true,
    output: body,
    bytesOut: body.length,
    meta: {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      cwd: path.relative(ctx.workspacePath, cwd) || ".",
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length,
      cleanedBytes: stdout.length + stderr.length,
    },
  };
}

interface BoundedRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

async function spawnBounded(invocation: ShellInvocation): Promise<BoundedRunResult> {
  return new Promise<BoundedRunResult>((resolve) => {
    const startedAt = Date.now();
    const [cmd, ...args] = invocation.argv;
    if (cmd === undefined) {
      resolve({
        exitCode: 127,
        stdout: "",
        stderr: "shell_exec: empty argv after parsing.",
        timedOut: false,
        durationMs: 0,
      });
      return;
    }
    // detached: true puts the command in its OWN process group, so a timeout
    // can kill the WHOLE tree (`kill(-pid)`), not just the bash leader. Without
    // this, a command that spawns a child holding the stdio pipes (a dev server,
    // a `&` background job) survives the leader's death, keeps the pipes open,
    // and `close` never fires — the exact freeze this guards against.
    const child = spawn(cmd, args, {
      cwd: invocation.cwd,
      env: invocation.envSnapshot,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    // Signal the whole process group (negative pid); fall back to the leader if
    // the group is already gone. Never throws (ESRCH on a dead group is fine).
    const killGroup = (signal: NodeJS.Signals): void => {
      if (typeof child.pid !== "number") return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    };

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    // Single settle path: clears BOTH timers so neither the kill escalation nor
    // the backstop can fire (or resolve) twice.
    const finish = (r: BoundedRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(backstop);
      resolve(r);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole group so a wedged child (held-open pipes) dies too and
      // `close` can fire — otherwise the tool hangs past the timeout forever.
      killGroup("SIGTERM");
      setTimeout(() => {
        if (!child.killed) killGroup("SIGKILL");
      }, 2000);
    }, invocation.timeoutMs);

    // Backstop: even SIGKILL on the group can fail to fire `close` if a surviving
    // grandchild keeps the stdio pipes open (re-parented daemon, FD inherited by
    // an unrelated process). Without this the tool promise never resolves and the
    // whole run goes silent past the timeout — the "stale run, no heartbeat" that
    // gets a healthy run cancelled. After the kill grace, force-destroy the pipes
    // and resolve with what we have so the agent always gets a result to act on.
    const backstop = setTimeout(() => {
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        // streams already gone
      }
      finish({
        exitCode: 124,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr:
          (stderrBytes > 0 ? `${Buffer.concat(stderr).toString("utf8")}\n` : "") +
          "shell_exec: process did not exit after timeout + SIGKILL; abandoned to keep the run alive.",
        timedOut: true,
        durationMs: Date.now() - startedAt,
      });
    }, invocation.timeoutMs + 5_000);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes < MAX_STDOUT_BYTES) {
        const remaining = MAX_STDOUT_BYTES - stdoutBytes;
        if (chunk.length <= remaining) {
          stdout.push(chunk);
          stdoutBytes += chunk.length;
        } else {
          stdout.push(chunk.subarray(0, remaining));
          stdoutBytes = MAX_STDOUT_BYTES;
          stdoutTruncated = true;
        }
      } else {
        stdoutTruncated = true;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < MAX_STDERR_BYTES) {
        const remaining = MAX_STDERR_BYTES - stderrBytes;
        if (chunk.length <= remaining) {
          stderr.push(chunk);
          stderrBytes += chunk.length;
        } else {
          stderr.push(chunk.subarray(0, remaining));
          stderrBytes = MAX_STDERR_BYTES;
          stderrTruncated = true;
        }
      } else {
        stderrTruncated = true;
      }
    });
    child.on("error", (error) => {
      finish({
        exitCode: 127,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: error.message,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("close", (code, signal) => {
      const outStr =
        Buffer.concat(stdout).toString("utf8") +
        (stdoutTruncated ? `\n…[stdout truncated at ${MAX_STDOUT_BYTES} bytes]` : "");
      const errStr =
        Buffer.concat(stderr).toString("utf8") +
        (stderrTruncated ? `\n…[stderr truncated at ${MAX_STDERR_BYTES} bytes]` : "");
      finish({
        exitCode: typeof code === "number" ? code : signal ? 128 : 1,
        stdout: outStr,
        stderr: errStr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

export const shellExecTool: ToolDefinition = {
  name: "shell_exec",
  description:
    "Run a shell command in the workspace. String commands run via `bash -o pipefail -c` (pipes / && / " +
    "redirects allowed). Array commands run as argv. Timeout 60s default, 600s cap. " +
    "stdout capped at 100 KB, stderr at 16 KB. Secrets are scrubbed from the env. " +
    "Use this for tests, builds, type checks, and other deterministic verification.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: {
        oneOf: [
          { type: "string", description: "Shell command line (run via sh -c)." },
          {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            description: "Direct argv (no shell expansion).",
          },
        ],
      },
      cwd: {
        type: "string",
        description: "Optional workspace-relative working directory. Defaults to workspace root.",
      },
      timeout_ms: {
        type: "integer",
        minimum: 1000,
        maximum: 600000,
        description: "Per-call timeout in ms.",
      },
    },
  },
  capability: "shell.exec",
  handler: shellExecHandler,
};

export const shellTools: ToolDefinition[] = [shellExecTool];
