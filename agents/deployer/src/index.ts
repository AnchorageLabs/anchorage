#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import {
  buildDeployPreview,
  DEPLOY_PREVIEW_ARTIFACT_TYPE,
  type DeployPreview,
  type DeployTrigger,
  ExitCode,
  type ProtocolEvent,
  type TaskEnvelope,
  validateTaskEnvelope,
} from "@anchorage/sdk";
import { Octokit } from "@octokit/rest";

type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonObject | JsonValue[] | boolean | null | number | string;

const execFileAsync = promisify(execFile);
const agentVersion = "0.1.0";
let eventSequence = 0;

/** The branch checked out in the workspace — the coder's pushed working branch. */
async function currentBranch(workspacePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", workspacePath, "rev-parse", "--abbrev-ref", "HEAD"], {
      timeout: 15_000,
    });
    const branch = stdout.trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

// How long to wait for the deployed environment to become live before giving up
// (bounded well under the agent timeout). The deploy keeps running on GitHub
// past this — we just stop blocking the pipeline on it.
const WATCH_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.ANCHORAGE_DEPLOY_WATCH_TIMEOUT_MS ?? 240_000),
);
const POLL_INTERVAL_MS = 6_000;

async function main(): Promise<number> {
  const task = parseTask(readFileSync(0, "utf8"));
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "deploy.trigger") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `deployer only supports deploy.trigger, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "deployer started", { agentVersion });

  const input = parseInput(task.value);

  // No environment selected → nothing to deploy. Non-blocking: continue to PR.
  if (!input.environment) {
    return finishNotApplicable(
      task.value,
      "No deploy environment selected — skipping the stage deploy.",
      input.environment,
    );
  }
  if (!input.owner || !input.name) {
    return finishNotApplicable(
      task.value,
      "No GitHub repository on the task — cannot deploy.",
      input.environment,
    );
  }
  // The branch to deploy is the run's working branch. Prefer an explicit ref
  // from the step input; otherwise read the workspace's checked-out branch (the
  // branch the coder pushed) — same source of truth pr-opener uses.
  const ref = input.ref ?? (await currentBranch(input.workspacePath));
  if (!ref) {
    return finishNotApplicable(
      task.value,
      "No branch to deploy (the coder produced no pushed branch).",
      input.environment,
    );
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    return fail(
      task.value,
      "missing_github_token",
      "Set GITHUB_TOKEN or GH_TOKEN to deploy via GitHub.",
      ExitCode.MissingCapability,
      input.environment,
    );
  }
  const octokit = new Octokit({ auth: token });
  const { owner, name: repo, environment, workspacePath } = input;

  try {
    // Auto-detect: prefer a workflow_dispatch deploy workflow that takes an
    // `environment`-like input; fall back to the GitHub Deployments API.
    const detected = await detectDeployWorkflow(workspacePath);
    let trigger: DeployTrigger;
    if (detected) {
      emit(task.value, "tool.requested", "info", `Dispatching deploy workflow ${detected.file}`, {
        tool: "github.actions.createWorkflowDispatch",
        input: { owner, repo, workflow: detected.file, ref, [detected.inputName]: environment },
      });
      await octokit.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: detected.file,
        ref,
        inputs: { [detected.inputName]: environment },
      });
      emit(task.value, "tool.result", "info", "Deploy workflow dispatched", {
        tool: "github.actions.createWorkflowDispatch",
        success: true,
        output: { workflow: detected.file },
      });
      trigger = { kind: "workflow_dispatch", workflow: detected.file };
    } else {
      emit(task.value, "tool.requested", "info", `Creating GitHub deployment for ${environment}`, {
        tool: "github.repos.createDeployment",
        input: { owner, repo, ref, environment },
      });
      const dep = await octokit.repos.createDeployment({
        owner,
        repo,
        ref,
        environment,
        auto_merge: false,
        required_contexts: [],
        description: `Anchorage stage deploy of ${ref} to ${environment}`,
      });
      // 202 = merged/queued without a deployment object; treat as triggered.
      const deploymentId =
        "id" in dep.data ? (dep.data.id as number) : undefined;
      emit(task.value, "tool.result", "info", "GitHub deployment created", {
        tool: "github.repos.createDeployment",
        success: true,
        output: deploymentId ? { deploymentId } : {},
      });
      trigger = { kind: "deployment", ...(deploymentId ? { deploymentId } : {}) };
    }

    // Watch until the environment is live (a deployment_status with a success
    // state and ideally an environment_url), or until the watch window closes.
    emit(task.value, "agent.progress", "info", `Waiting for ${environment} to come up…`, {
      environment,
    });
    const outcome = await watchEnvironment(octokit, owner, repo, environment, ref);

    if (outcome.state === "failed") {
      const preview = buildDeployPreview({
        status: "failed",
        summary: `Deploy to ${environment} failed.`,
        environment,
        ref,
        trigger,
        error: outcome.detail ?? "deployment reported a failure state",
      });
      const artifact = await writeArtifact(task.value, preview);
      emit(task.value, "artifact.created", "info", "Deploy preview artifact created", artifact);
      emit(task.value, "agent.failed", "error", "Deploy to stage failed", {
        error: { code: "deploy_failed", message: preview.error ?? "deploy failed" },
        artifact,
      });
      return ExitCode.PartialSuccessAttentionRequired;
    }

    // Live (or triggered and not observed-failed within the window): pause for
    // human inspection. previewUrl prefers the environment URL, else the run URL.
    const previewUrl = outcome.environmentUrl ?? outcome.runUrl;
    const preview = buildDeployPreview({
      status: "running",
      summary: outcome.environmentUrl
        ? `Deployed ${ref} to ${environment} — open the preview to inspect.`
        : `Deploy to ${environment} triggered for ${ref} — awaiting your approval.`,
      environment,
      ref,
      ...(previewUrl ? { previewUrl } : {}),
      trigger: { ...trigger, ...(outcome.runUrl ? { runUrl: outcome.runUrl } : {}) },
    });
    const artifact = await writeArtifact(task.value, preview);
    emit(
      task.value,
      "agent.output",
      "info",
      "Deploy preview prepared",
      preview as unknown as ProtocolEvent["data"],
    );
    emit(task.value, "artifact.created", "info", "Deploy preview artifact created", artifact);
    emit(task.value, "agent.completed", "info", "deployer completed — awaiting approval", {
      environment,
      previewUrl: previewUrl ?? null,
      artifact,
    });
    return ExitCode.Success;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(task.value, "deploy_trigger_failed", message, ExitCode.ExternalDependencyFailure, environment);
  }
}

// ── deploy-workflow auto-detection ──────────────────────────────────────────────
// Scan the cloned repo's .github/workflows for a workflow_dispatch deploy that
// accepts an environment-like input. Tolerant text scan (no YAML dependency in
// the agent runtime, matching the policy-check agent's approach).

const ENV_INPUT_NAMES = ["environment", "env", "stage", "target", "deploy_env"];

async function detectDeployWorkflow(
  workspacePath: string,
): Promise<{ file: string; inputName: string } | null> {
  if (!workspacePath) return null;
  const dir = path.join(workspacePath, ".github", "workflows");
  let entries: string[];
  try {
    entries = (await fs.readdir(dir)).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    return null;
  }
  // Prefer files whose name hints at deploying.
  entries.sort((a, b) => score(b) - score(a));
  for (const file of entries) {
    let text: string;
    try {
      text = await fs.readFile(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    if (!/^\s*on:|workflow_dispatch/m.test(text)) continue;
    if (!/workflow_dispatch/.test(text)) continue;
    const inputName = ENV_INPUT_NAMES.find((n) =>
      new RegExp(`^\\s{2,}${n}\\s*:`, "m").test(text),
    );
    if (inputName) return { file, inputName };
  }
  return null;
}

function score(file: string): number {
  const f = file.toLowerCase();
  if (/deploy/.test(f)) return 3;
  if (/release|cd|stage|ship/.test(f)) return 2;
  return 0;
}

// ── environment watch ───────────────────────────────────────────────────────────

interface WatchOutcome {
  state: "live" | "failed" | "pending";
  environmentUrl?: string;
  runUrl?: string;
  detail?: string;
}

async function watchEnvironment(
  octokit: Octokit,
  owner: string,
  repo: string,
  environment: string,
  ref: string,
): Promise<WatchOutcome> {
  const deadline = Date.now() + WATCH_TIMEOUT_MS;
  let runUrl: string | undefined;
  while (Date.now() < deadline) {
    // 1. Most recent deployment for this environment.
    try {
      const deployments = await octokit.repos.listDeployments({
        owner,
        repo,
        environment,
        per_page: 5,
      });
      const dep = deployments.data.find((d) => d.ref === ref) ?? deployments.data[0];
      if (dep) {
        const statuses = await octokit.repos.listDeploymentStatuses({
          owner,
          repo,
          deployment_id: dep.id,
          per_page: 10,
        });
        const latest = statuses.data[0];
        if (latest) {
          const state = latest.state;
          const environmentUrl =
            (latest.environment_url as string | undefined) || undefined;
          if (state === "success") return { state: "live", environmentUrl, runUrl };
          if (state === "failure" || state === "error") {
            return { state: "failed", detail: latest.description ?? state, runUrl };
          }
        }
      }
    } catch {
      // deployments not readable / none yet — keep polling
    }
    // 2. The dispatched workflow run (for a traceable URL while we wait).
    try {
      const runs = await octokit.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        branch: ref,
        per_page: 5,
      });
      const run = runs.data.workflow_runs?.[0];
      if (run) {
        runUrl = run.html_url;
        if (run.status === "completed") {
          if (run.conclusion === "failure" || run.conclusion === "timed_out") {
            return { state: "failed", detail: `deploy workflow ${run.conclusion}`, runUrl };
          }
          // completed successfully but no deployment_status URL — still "live"
          // enough to inspect via the run; the user approves from there.
          if (run.conclusion === "success") return { state: "live", runUrl };
        }
      }
    } catch {
      // no Actions access — rely on deployments
    }
    await delay(POLL_INTERVAL_MS);
  }
  // Window closed without a terminal signal: treat as live-enough to pause on,
  // so the user can decide; surface whatever run URL we have.
  return { state: "live", runUrl };
}

// ── input parsing ─────────────────────────────────────────────────────────────

function parseInput(task: TaskEnvelope): {
  environment: string | null;
  owner: string | null;
  name: string | null;
  ref: string | null;
  workspacePath: string;
} {
  const input = (task.input ?? {}) as JsonObject;
  const deployment = isObject(input.deployment) ? input.deployment : {};
  const repository = (task.repository ?? {}) as { owner?: string; name?: string };
  return {
    environment: readString(deployment.environment) ?? readString(input.environment),
    owner: readString(repository.owner),
    name: readString(repository.name),
    // The branch to deploy is the run's working branch — passed by the workflow
    // step from the coder's code.change.result, else the run branch.
    ref: readString(input.ref) ?? readString(input.branch),
    workspacePath: readString(input.workspacePath) ?? process.cwd(),
  };
}

function finishNotApplicable(task: TaskEnvelope, summary: string, environment: string | null): number {
  const preview = buildDeployPreview({
    status: "not_applicable",
    summary,
    environment: environment ?? "(none)",
  });
  void writeArtifact(task, preview).then((artifact) => {
    emit(task, "artifact.created", "info", "Deploy preview artifact created", artifact);
    emit(task, "agent.completed", "info", "deployer: nothing to deploy", { artifact });
  });
  return ExitCode.Success;
}

// ── plumbing ───────────────────────────────────────────────────────────────────

function parseTask(rawTask: string): { ok: true; value: TaskEnvelope } | { ok: false; exitCode: number } {
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

function fail(
  task: TaskEnvelope,
  code: string,
  message: string,
  exitCode: number,
  environment: string | null,
): number {
  emit(task, "agent.failed", "error", message, {
    error: { code, message },
    ...(environment ? { environment } : {}),
  });
  return exitCode;
}

async function writeArtifact(task: TaskEnvelope, preview: DeployPreview) {
  const artifactRoot =
    process.env.ANCHORAGE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "anchorage-agent-artifacts", task.run.id);
  await fs.mkdir(artifactRoot, { recursive: true });
  const artifactPath = path.join(artifactRoot, "deploy-preview.json");
  const content = `${JSON.stringify(preview, null, 2)}\n`;
  await fs.writeFile(artifactPath, content, "utf8");
  return {
    artifactType: DEPLOY_PREVIEW_ARTIFACT_TYPE,
    uri: `file://${artifactPath}`,
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(content),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readString(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
