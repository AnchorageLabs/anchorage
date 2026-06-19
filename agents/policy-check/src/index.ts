#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  evaluateForbidImports,
  getIndexStore,
  type ImportGraphView,
  type PolicyViolation,
  parseConstraints,
} from "@anchorage/agent-llm";
import {
  buildRevisionRequest,
  ExitCode,
  type ProtocolEvent,
  REVISION_REQUEST_ARTIFACT_TYPE,
  type TaskEnvelope,
  validateTaskEnvelope,
} from "@anchorage/sdk";

type JsonValue = { [k: string]: JsonValue } | JsonValue[] | boolean | null | number | string;

const agentVersion = "0.1.0";
const CONSTRAINTS_PATH = ".anchorage/constraints.yaml";
let eventSequence = 0;

async function main(): Promise<number> {
  const task = parseTask(readFileSync(0, "utf8"));
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "policy.check") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `policy-check only supports policy.check, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "policy-check started", { agentVersion });

  const workspacePath = resolveWorkspacePath(task.value.input.workspacePath);
  if (!workspacePath) {
    emit(task.value, "agent.failed", "error", "Missing workspace path", {
      error: {
        code: "missing_workspace_path",
        message: "policy-check requires input.workspacePath pointing at the repository worktree.",
      },
    });
    return ExitCode.InvalidInput;
  }

  // Read constraints. Absent or unreadable → no rules: a repo without a committed
  // constraints.yaml is unconstrained, not a failure. Governance is opt-in.
  const constraintsText = await fs
    .readFile(path.join(workspacePath, CONSTRAINTS_PATH), "utf8")
    .catch(() => null);
  if (constraintsText === null) {
    emit(
      task.value,
      "agent.completed",
      "info",
      "No .anchorage/constraints.yaml; nothing to check",
      {
        checked: false,
      },
    );
    return ExitCode.Success;
  }

  const { rules, warnings } = parseConstraints(constraintsText);
  for (const warning of warnings) {
    emit(task.value, "agent.output", "warn", warning, { warning });
  }
  if (rules.length === 0) {
    emit(task.value, "agent.completed", "info", "No enforceable graph rules in constraints.yaml", {
      checked: true,
      ruleCount: 0,
    });
    return ExitCode.Success;
  }

  const changedFiles = await gitChangedFiles(workspacePath, task.value.repository?.defaultBranch);
  emit(task.value, "agent.output", "info", `Evaluating ${rules.length} rule(s)`, {
    ruleCount: rules.length,
    changedFileCount: changedFiles.length,
  });

  // Build the import-graph view from the persisted index. Fail open: if the index
  // can't be built (no git / parse failure) there is nothing to evaluate, so a
  // missing index never invents a violation.
  const graph = await buildGraph(workspacePath);
  const violations = evaluateForbidImports(rules, changedFiles, graph);
  const hard = violations.filter((v) => v.severity === "hard");
  const soft = violations.filter((v) => v.severity === "soft");

  for (const v of soft) {
    emit(
      task.value,
      "agent.output",
      "warn",
      `soft policy violation: ${v.message}`,
      toData({ violation: v }),
    );
  }

  if (hard.length === 0) {
    emit(task.value, "agent.completed", "info", "No hard policy violations", {
      checked: true,
      ruleCount: rules.length,
      softViolations: soft.length,
    });
    return ExitCode.Success;
  }

  // Hard violations ride back to the coder on the existing feedback loop as a
  // code.revision.request — the same machinery the tester/reviewer use.
  const artifact = await writeRevisionArtifact(task.value, hard);
  emit(
    task.value,
    "agent.output",
    "error",
    `${hard.length} hard policy violation(s)`,
    toData({
      violations: hard,
    }),
  );
  emit(task.value, "artifact.created", "info", "Revision request artifact created", artifact);
  emit(task.value, "agent.failed", "error", "Architecture constraints violated", {
    error: {
      code: "policy_violated",
      message: hard.map((v) => v.message).join("; "),
    },
    artifact,
  });
  // Same exit code the tester uses for a fixable gate failure: the orchestrator
  // loops it back to the coder rather than hard-failing the run.
  return ExitCode.PartialSuccessAttentionRequired;
}

async function buildGraph(workspacePath: string): Promise<ImportGraphView> {
  try {
    const store = await getIndexStore(workspacePath);
    if (!store) return { allFiles: [], importersOf: () => [] };
    const allFiles = store.inDegreeRanking().map((r) => r.file);
    return { allFiles, importersOf: (t) => store.directImportersOf(t) };
  } catch {
    return { allFiles: [], importersOf: () => [] };
  }
}

/**
 * Files changed by this run. Prefer the branch diff against the base
 * (`<base>...HEAD`, the coder's committed changes); fall back to the working-tree
 * diff. Returns [] on any git failure (fail open — no diff, no violations).
 */
async function gitChangedFiles(workspacePath: string, base?: string): Promise<string[]> {
  const baseRef = base?.trim() || "main";
  for (const args of [
    ["diff", "--name-only", `${baseRef}...HEAD`],
    ["diff", "--name-only", "HEAD"],
    ["diff", "--name-only"],
  ]) {
    const out = await git(workspacePath, args);
    const files = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (files.length > 0) return [...new Set(files)];
  }
  return [];
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.on("error", () => resolve(""));
    child.on("close", (code) => resolve(code === 0 ? out : ""));
  });
}

async function writeRevisionArtifact(task: TaskEnvelope, violations: PolicyViolation[]) {
  const revision = buildRevisionRequest({
    fromAgent: "policy-check",
    reason: "policy_violated",
    summary:
      violations.length === 1
        ? `1 architecture constraint violated`
        : `${violations.length} architecture constraints violated`,
    failures: violations.map((v) => ({
      name: v.ruleId,
      command: v.file,
      details: v.message,
    })),
  });

  const artifactRoot =
    process.env.ANCHORAGE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "anchorage-agent-artifacts", task.run.id);
  await fs.mkdir(artifactRoot, { recursive: true });
  const artifactPath = path.join(artifactRoot, "revision-request.json");
  const content = `${JSON.stringify(revision, null, 2)}\n`;
  await fs.writeFile(artifactPath, content, "utf8");
  return {
    artifactType: REVISION_REQUEST_ARTIFACT_TYPE,
    uri: `file://${artifactPath}`,
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(content),
  };
}

function parseTask(
  rawTask: string,
): { ok: true; value: TaskEnvelope } | { ok: false; exitCode: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawTask);
  } catch (error) {
    console.error(`Invalid task JSON: ${(error as Error).message}`);
    return { ok: false, exitCode: ExitCode.InvalidInput };
  }
  const result = validateTaskEnvelope(parsed);
  if (!result.ok) {
    for (const validationError of result.errors) console.error(JSON.stringify(validationError));
    return { ok: false, exitCode: ExitCode.InvalidInput };
  }
  return { ok: true, value: result.value };
}

function resolveWorkspacePath(value: JsonValue | undefined): null | string {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return path.resolve(process.cwd(), value);
}

/** Cast structured payloads to the event `data` shape (they are JSON-serializable). */
function toData(value: unknown): ProtocolEvent["data"] {
  return value as ProtocolEvent["data"];
}

function emit(
  task: TaskEnvelope,
  type: ProtocolEvent["type"],
  level: ProtocolEvent["level"],
  message: string,
  data: ProtocolEvent["data"],
): void {
  const event: ProtocolEvent = {
    protocolVersion: task.protocolVersion,
    eventId: `evt_${type.replaceAll(".", "_")}_${Date.now()}_${++eventSequence}`,
    runId: task.run.id,
    taskId: task.task.id,
    timestamp: new Date().toISOString(),
    type,
    level,
    message,
    data,
  };
  writeSync(1, `${JSON.stringify(event)}\n`);
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
