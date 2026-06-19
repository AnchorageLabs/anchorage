import { spawn } from "node:child_process";
import path from "node:path";
import { checkShellBudget, recordShell } from "../budget.js";
import type { JsonObject, ToolContext, ToolDefinition, ToolHandlerResult } from "../types.js";
import { cleanTerminalOutput, shellCleanEnabled } from "./output-clean.js";

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

function buildArgv(
  command: unknown,
): { ok: true; argv: string[] } | { ok: false; message: string } {
  // String form runs through bash with pipefail so the model can use pipes,
  // redirects, and shell expansion without hiding failures before `| tail`.
  if (typeof command === "string") {
    const trimmed = command.trim();
    if (!trimmed) return { ok: false, message: "shell_exec: command string is empty." };
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
    const child = spawn(cmd, args, {
      cwd: invocation.cwd,
      env: invocation.envSnapshot,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
        // SIGKILL fallback if SIGTERM didn't take.
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 2000);
      } catch {
        // process likely already gone
      }
    }, invocation.timeoutMs);

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
      clearTimeout(timer);
      resolve({
        exitCode: 127,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: error.message,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const outStr =
        Buffer.concat(stdout).toString("utf8") +
        (stdoutTruncated ? `\n…[stdout truncated at ${MAX_STDOUT_BYTES} bytes]` : "");
      const errStr =
        Buffer.concat(stderr).toString("utf8") +
        (stderrTruncated ? `\n…[stderr truncated at ${MAX_STDERR_BYTES} bytes]` : "");
      resolve({
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
