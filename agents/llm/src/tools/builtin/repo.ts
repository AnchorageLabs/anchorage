import { spawn } from "node:child_process";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkFileBudget, recordFile } from "../budget.js";
import type { JsonObject, ToolContext, ToolDefinition, ToolHandlerResult } from "../types.js";

// ── Path safety ─────────────────────────────────────────────────────────────

interface SafePath {
  absolutePath: string;
  relativePath: string;
}

function resolveInsideWorkspace(workspace: string, requested: string): null | SafePath {
  if (typeof requested !== "string") return null;
  const normalized = requested.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized) {
    return { absolutePath: workspace, relativePath: "." };
  }
  if (normalized.includes("..")) return null;
  const absolutePath = path.resolve(workspace, normalized);
  const relativePath = path.relative(workspace, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
  return { absolutePath, relativePath: relativePath || "." };
}

// ── git invocation ──────────────────────────────────────────────────────────

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runGit(cwd: string, args: string[], maxBytes = 1_000_000): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes < maxBytes) {
        const remaining = maxBytes - stdoutBytes;
        if (chunk.length <= remaining) {
          stdout.push(chunk);
          stdoutBytes += chunk.length;
        } else {
          stdout.push(chunk.subarray(0, remaining));
          stdoutBytes = maxBytes;
          truncated = true;
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < 8192) {
        const remaining = 8192 - stderrBytes;
        const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        stderr.push(slice);
        stderrBytes += slice.length;
      }
    });
    child.on("error", (error) => resolve({ exitCode: 127, stdout: "", stderr: error.message }));
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8") + (truncated ? "\n…[truncated]" : "");
      resolve({
        exitCode: code ?? 1,
        stdout: out,
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

// ── read_file ───────────────────────────────────────────────────────────────

const READ_FILE_MAX_BYTES = 100_000;

async function readFileHandler(input: JsonObject, ctx: ToolContext): Promise<ToolHandlerResult> {
  const requestedPath = typeof input.path === "string" ? input.path : "";
  if (!requestedPath) {
    return { ok: false, code: "invalid_input", message: "read_file requires a 'path' string." };
  }
  const safe = resolveInsideWorkspace(ctx.workspacePath, requestedPath);
  if (!safe) {
    return {
      ok: false,
      code: "path_outside_workspace",
      message: `Refusing to read path outside workspace: ${requestedPath}`,
    };
  }

  const budgetCheck = checkFileBudget(ctx.budget, safe.relativePath);
  if (!budgetCheck.ok) {
    return {
      ok: false,
      code: "budget_exceeded",
      message: budgetCheck.message ?? "File budget exceeded.",
    };
  }

  const stats = await stat(safe.absolutePath).catch(() => null);
  if (!stats?.isFile()) {
    return {
      ok: false,
      code: "not_a_file",
      message: `Path does not point to a regular file: ${safe.relativePath}`,
    };
  }
  if (stats.size > READ_FILE_MAX_BYTES * 4) {
    return {
      ok: false,
      code: "file_too_large",
      message: `File ${safe.relativePath} is ${stats.size} bytes (cap ${READ_FILE_MAX_BYTES * 4}).`,
    };
  }

  let content: string;
  try {
    content = await readFile(safe.absolutePath, "utf8");
  } catch (error) {
    return {
      ok: false,
      code: "read_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const lineRange = pickLineRange(input.line_range);
  let body = content;
  let rangeNote = "";
  if (lineRange) {
    const lines = content.split("\n");
    const startIdx = Math.max(1, lineRange[0]) - 1;
    const endIdx = Math.min(lines.length, lineRange[1]);
    body = lines.slice(startIdx, endIdx).join("\n");
    rangeNote = ` (lines ${startIdx + 1}-${endIdx} of ${lines.length})`;
  }

  if (body.length > READ_FILE_MAX_BYTES) {
    body = `${body.slice(0, READ_FILE_MAX_BYTES)}\n…[truncated at ${READ_FILE_MAX_BYTES} bytes]`;
  }

  recordFile(ctx.budget, safe.relativePath, body.length);
  return {
    ok: true,
    output: `=== ${safe.relativePath}${rangeNote} ===\n${body}`,
    bytesOut: body.length,
    meta: { path: safe.relativePath, bytes: body.length, totalBytes: stats.size },
  };
}

function pickLineRange(value: unknown): null | [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const start = Number(value[0]);
  const end = Number(value[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end < start) return null;
  return [Math.floor(start), Math.floor(end)];
}

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description:
    "Read a UTF-8 file from the workspace. Returns up to 100 KB. " +
    "Use line_range to fetch only part of a larger file. Path-sandboxed to the workspace root.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", description: "Workspace-relative path." },
      line_range: {
        type: "array",
        items: { type: "integer", minimum: 1 },
        minItems: 2,
        maxItems: 2,
        description: "Optional [start, end] inclusive line numbers (1-based).",
      },
    },
  },
  capability: "repo.read",
  handler: readFileHandler,
};

// ── list_dir (git-tracked) ──────────────────────────────────────────────────

async function listDirHandler(input: JsonObject, ctx: ToolContext): Promise<ToolHandlerResult> {
  const requestedPath = typeof input.path === "string" ? input.path : "";
  const safe = resolveInsideWorkspace(ctx.workspacePath, requestedPath);
  if (!safe) {
    return {
      ok: false,
      code: "path_outside_workspace",
      message: `Refusing to list path outside workspace: ${requestedPath}`,
    };
  }
  const maxEntries =
    typeof input.max_entries === "number" && input.max_entries > 0
      ? Math.floor(input.max_entries)
      : 200;
  const glob = typeof input.glob === "string" ? input.glob : null;

  const args = ["ls-files", "--cached", "--others", "--exclude-standard"];
  if (safe.relativePath !== "." && safe.relativePath !== "") {
    args.push("--", safe.relativePath);
  }
  if (glob && safe.relativePath !== "." && safe.relativePath !== "") {
    args.push(`${safe.relativePath}/${glob}`);
  } else if (glob) {
    args.push(glob);
  }

  const result = await runGit(ctx.workspacePath, args);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      code: "git_ls_files_failed",
      message: result.stderr.trim() || `git ls-files exited ${result.exitCode}`,
    };
  }

  const entries = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const truncated = entries.length > maxEntries;
  const shown = truncated ? entries.slice(0, maxEntries) : entries;
  const body =
    shown.join("\n") +
    (truncated ? `\n…[${entries.length - maxEntries} more entries truncated]` : "");

  return {
    ok: true,
    output: `=== ${safe.relativePath} (${entries.length} entries${truncated ? `, ${maxEntries} shown` : ""}) ===\n${body}`,
    bytesOut: body.length,
    meta: { path: safe.relativePath, total: entries.length, shown: shown.length },
  };
}

export const listDirTool: ToolDefinition = {
  name: "list_dir",
  description:
    "List git-tracked + untracked-but-not-ignored files under a workspace path. " +
    "Use this to discover the repo layout. Bounded to 200 entries by default; pass max_entries to raise.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", description: "Workspace-relative dir. Empty = repo root." },
      glob: { type: "string", description: "Optional glob pattern (git pathspec syntax)." },
      max_entries: { type: "integer", minimum: 1, maximum: 5000 },
    },
  },
  capability: "repo.read",
  handler: listDirHandler,
};

// ── grep ────────────────────────────────────────────────────────────────────

async function grepHandler(input: JsonObject, ctx: ToolContext): Promise<ToolHandlerResult> {
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  if (!pattern) {
    return { ok: false, code: "invalid_input", message: "grep requires a 'pattern' string." };
  }
  const requestedPath = typeof input.path === "string" ? input.path : "";
  const safe = resolveInsideWorkspace(ctx.workspacePath, requestedPath);
  if (!safe) {
    return {
      ok: false,
      code: "path_outside_workspace",
      message: `Refusing to grep path outside workspace: ${requestedPath}`,
    };
  }
  const maxMatches =
    typeof input.max_matches === "number" && input.max_matches > 0
      ? Math.floor(input.max_matches)
      : 50;
  const includeGlob = typeof input.include_glob === "string" ? input.include_glob : null;

  const args = [
    "grep",
    "-n",
    "-I", // skip binary
    "--max-count",
    String(maxMatches),
    "-e",
    pattern,
  ];
  if (safe.relativePath !== "." && safe.relativePath !== "") {
    args.push("--", safe.relativePath);
  } else if (includeGlob) {
    args.push("--");
  }
  if (includeGlob) {
    args.push(safe.relativePath === "." ? includeGlob : `${safe.relativePath}/${includeGlob}`);
  }

  const result = await runGit(ctx.workspacePath, args, 200_000);
  // exit 1 = no matches; not an error
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return {
      ok: false,
      code: "git_grep_failed",
      message: result.stderr.trim() || `git grep exited ${result.exitCode}`,
    };
  }

  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  const truncated = lines.length >= maxMatches;
  const body =
    lines.length === 0
      ? `(no matches for /${pattern}/)`
      : lines.join("\n") + (truncated ? "\n…[result cap reached]" : "");

  return {
    ok: true,
    output: `=== grep /${pattern}/${safe.relativePath !== "." ? ` in ${safe.relativePath}` : ""} ===\n${body}`,
    bytesOut: body.length,
    meta: { pattern, matches: lines.length, truncated },
  };
}

export const grepTool: ToolDefinition = {
  name: "grep",
  description:
    "Search for a pattern across git-tracked files. Returns up to 50 matches by default. " +
    "Use this to find symbol definitions/uses, error messages, or feature flags. " +
    "Pattern is git-grep's ERE syntax.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "Extended regex pattern." },
      path: { type: "string", description: "Optional workspace-relative dir to limit search." },
      include_glob: { type: "string", description: "Optional glob (git pathspec)." },
      max_matches: { type: "integer", minimum: 1, maximum: 500 },
    },
  },
  capability: "repo.read",
  handler: grepHandler,
};

// ── git_log ─────────────────────────────────────────────────────────────────

async function gitLogHandler(input: JsonObject, ctx: ToolContext): Promise<ToolHandlerResult> {
  const requestedPath = typeof input.path === "string" ? input.path : "";
  const safe = resolveInsideWorkspace(ctx.workspacePath, requestedPath);
  if (!safe) {
    return {
      ok: false,
      code: "path_outside_workspace",
      message: `Refusing to log path outside workspace: ${requestedPath}`,
    };
  }
  const maxCommits =
    typeof input.max_commits === "number" && input.max_commits > 0
      ? Math.min(50, Math.floor(input.max_commits))
      : 10;
  const since = typeof input.since === "string" ? input.since : "90.days.ago";

  const args = [
    "log",
    `--max-count=${maxCommits}`,
    `--since=${since}`,
    "--pretty=format:%h%x09%ad%x09%an%x09%s",
    "--date=short",
  ];
  if (safe.relativePath !== "." && safe.relativePath !== "") {
    args.push("--", safe.relativePath);
  }

  const result = await runGit(ctx.workspacePath, args, 200_000);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      code: "git_log_failed",
      message: result.stderr.trim() || `git log exited ${result.exitCode}`,
    };
  }

  const body =
    result.stdout.trim().length === 0
      ? `(no commits in ${since} for ${safe.relativePath})`
      : result.stdout;

  return {
    ok: true,
    output: `=== git log ${safe.relativePath} (since ${since}) ===\nsha\tdate\tauthor\tsubject\n${body}`,
    bytesOut: body.length,
    meta: { path: safe.relativePath, since },
  };
}

export const gitLogTool: ToolDefinition = {
  name: "git_log",
  description:
    "Show recent commits touching a workspace path (last 90 days by default). " +
    "Use this to understand how a file or directory has evolved and who last changed it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", description: "Workspace-relative path. Empty = whole repo." },
      since: {
        type: "string",
        description: "git --since value (e.g. '30.days.ago', '2026-01-01').",
      },
      max_commits: { type: "integer", minimum: 1, maximum: 50 },
    },
  },
  capability: "repo.read",
  handler: gitLogHandler,
};

// ── git_show ────────────────────────────────────────────────────────────────

async function gitShowHandler(input: JsonObject, ctx: ToolContext): Promise<ToolHandlerResult> {
  const sha = typeof input.sha === "string" ? input.sha : "";
  if (!sha || !/^[0-9a-fA-F]{4,40}$/.test(sha)) {
    return { ok: false, code: "invalid_input", message: "git_show requires a valid commit sha." };
  }
  const requestedPath = typeof input.path === "string" ? input.path : "";
  const safe = requestedPath ? resolveInsideWorkspace(ctx.workspacePath, requestedPath) : null;
  if (requestedPath && !safe) {
    return {
      ok: false,
      code: "path_outside_workspace",
      message: `Refusing to show path outside workspace: ${requestedPath}`,
    };
  }

  const args = ["show", "--stat", "--patch", sha];
  if (safe && safe.relativePath !== "." && safe.relativePath !== "") {
    args.push("--", safe.relativePath);
  }
  const result = await runGit(ctx.workspacePath, args, 300_000);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      code: "git_show_failed",
      message: result.stderr.trim() || `git show exited ${result.exitCode}`,
    };
  }

  return {
    ok: true,
    output: `=== git show ${sha}${safe?.relativePath && safe.relativePath !== "." ? ` -- ${safe.relativePath}` : ""} ===\n${result.stdout}`,
    bytesOut: result.stdout.length,
    meta: { sha, path: safe?.relativePath ?? null },
  };
}

export const gitShowTool: ToolDefinition = {
  name: "git_show",
  description: "Show a commit's stat + patch. Optionally narrowed to a path.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["sha"],
    properties: {
      sha: { type: "string", description: "Commit SHA (4–40 hex chars)." },
      path: { type: "string", description: "Optional workspace-relative path to filter." },
    },
  },
  capability: "repo.read",
  handler: gitShowHandler,
};

// ── git_diff ────────────────────────────────────────────────────────────────

async function gitDiffHandler(input: JsonObject, ctx: ToolContext): Promise<ToolHandlerResult> {
  const refA = typeof input.ref_a === "string" ? input.ref_a : "";
  const refB = typeof input.ref_b === "string" ? input.ref_b : "";
  if (!refA || !refB) {
    return {
      ok: false,
      code: "invalid_input",
      message: "git_diff requires ref_a and ref_b.",
    };
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(refA) || !/^[A-Za-z0-9._/-]+$/.test(refB)) {
    return {
      ok: false,
      code: "invalid_input",
      message: "ref_a and ref_b must be plain git refs (no shell metacharacters).",
    };
  }
  const requestedPath = typeof input.path === "string" ? input.path : "";
  const safe = requestedPath ? resolveInsideWorkspace(ctx.workspacePath, requestedPath) : null;
  if (requestedPath && !safe) {
    return {
      ok: false,
      code: "path_outside_workspace",
      message: `Refusing to diff path outside workspace: ${requestedPath}`,
    };
  }

  const args = ["diff", "--stat", "--patch", `${refA}...${refB}`];
  if (safe && safe.relativePath !== "." && safe.relativePath !== "") {
    args.push("--", safe.relativePath);
  }
  const result = await runGit(ctx.workspacePath, args, 300_000);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      code: "git_diff_failed",
      message: result.stderr.trim() || `git diff exited ${result.exitCode}`,
    };
  }

  return {
    ok: true,
    output: `=== git diff ${refA}...${refB}${safe?.relativePath && safe.relativePath !== "." ? ` -- ${safe.relativePath}` : ""} ===\n${result.stdout}`,
    bytesOut: result.stdout.length,
    meta: { refA, refB, path: safe?.relativePath ?? null },
  };
}

export const gitDiffTool: ToolDefinition = {
  name: "git_diff",
  description: "Diff between two git refs (three-dot notation). Optionally narrowed to a path.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["ref_a", "ref_b"],
    properties: {
      ref_a: { type: "string" },
      ref_b: { type: "string" },
      path: { type: "string" },
    },
  },
  capability: "repo.read",
  handler: gitDiffHandler,
};

// ── write_file (capability: workspace.write) ────────────────────────────────

async function writeFileHandler(input: JsonObject, ctx: ToolContext): Promise<ToolHandlerResult> {
  const requestedPath = typeof input.path === "string" ? input.path : "";
  if (!requestedPath) {
    return { ok: false, code: "invalid_input", message: "write_file requires a 'path' string." };
  }
  const content = typeof input.content === "string" ? input.content : null;
  if (content === null) {
    return { ok: false, code: "invalid_input", message: "write_file requires a 'content' string." };
  }
  const safe = resolveInsideWorkspace(ctx.workspacePath, requestedPath);
  if (!safe) {
    return {
      ok: false,
      code: "path_outside_workspace",
      message: `Refusing to write outside workspace: ${requestedPath}`,
    };
  }
  if (content.length > 1_000_000) {
    return {
      ok: false,
      code: "content_too_large",
      message: `write_file content cap is 1 MB; got ${content.length} bytes.`,
    };
  }
  try {
    await mkdir(path.dirname(safe.absolutePath), { recursive: true });
    await writeFile(safe.absolutePath, content, "utf8");
  } catch (error) {
    return {
      ok: false,
      code: "write_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    ok: true,
    output: `Wrote ${content.length} bytes to ${safe.relativePath}.`,
    bytesOut: content.length,
    meta: { path: safe.relativePath, bytes: content.length },
  };
}

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description:
    "Write a UTF-8 file in the workspace, creating directories as needed. Overwrites any " +
    "existing file at the path. Use this to apply code changes during the loop; the orchestrator " +
    "picks up the changes via git after the run.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content"],
    properties: {
      path: { type: "string", description: "Workspace-relative path." },
      content: { type: "string", description: "Full file content (UTF-8)." },
    },
  },
  capability: "workspace.write",
  handler: writeFileHandler,
};

// ── delete_file (capability: workspace.write) ───────────────────────────────

async function deleteFileHandler(input: JsonObject, ctx: ToolContext): Promise<ToolHandlerResult> {
  const requestedPath = typeof input.path === "string" ? input.path : "";
  if (!requestedPath) {
    return { ok: false, code: "invalid_input", message: "delete_file requires a 'path' string." };
  }
  const safe = resolveInsideWorkspace(ctx.workspacePath, requestedPath);
  if (!safe) {
    return {
      ok: false,
      code: "path_outside_workspace",
      message: `Refusing to delete outside workspace: ${requestedPath}`,
    };
  }
  try {
    await unlink(safe.absolutePath);
  } catch (error) {
    return {
      ok: false,
      code: "delete_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    ok: true,
    output: `Deleted ${safe.relativePath}.`,
    meta: { path: safe.relativePath },
  };
}

export const deleteFileTool: ToolDefinition = {
  name: "delete_file",
  description:
    "Delete a file from the workspace. The orchestrator picks up the deletion via git after " +
    "the run. Use sparingly; prefer empty/replaced content via write_file when the path should " +
    "remain.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", description: "Workspace-relative path to delete." },
    },
  },
  capability: "workspace.write",
  handler: deleteFileHandler,
};

// ── Bundle ──────────────────────────────────────────────────────────────────

export const repoReadTools: ToolDefinition[] = [
  readFileTool,
  listDirTool,
  grepTool,
  gitLogTool,
  gitShowTool,
  gitDiffTool,
];

export const repoWriteTools: ToolDefinition[] = [writeFileTool, deleteFileTool];
