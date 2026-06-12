#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  type AgentManifest,
  buildTaskRunManifest,
  ExitCode,
  parseNdjsonEvents,
  type TaskEnvelope,
  validateAgentManifest,
  validateEventStream,
  validateTaskEnvelope,
} from "@anchorage/sdk";

interface ResolvedAgent {
  manifest: AgentManifest;
  manifestDir: string;
}

async function main(): Promise<number> {
  const [, , command, agentRef] = process.argv;

  if (command !== "run" || !agentRef) {
    printUsage();
    return ExitCode.InvalidInput;
  }

  const rawTask = await readStdin();
  const task = parseTaskEnvelope(rawTask);
  if (!task.ok) return task.exitCode;

  const agent = await resolveAgent(agentRef, process.cwd());
  if (!agent.ok) return agent.exitCode;

  const compatibility = checkAgentCompatibility(agent.value.manifest, task.value);
  if (!compatibility.ok) {
    console.error(compatibility.message);
    return compatibility.exitCode;
  }

  return runAgent(agent.value, task.value, rawTask);
}

function printUsage(): void {
  console.error("Usage: anchorage run <agent-name-or-path> < task.json");
}

async function readStdin(): Promise<string> {
  return readFileSync(0, "utf8");
}

function parseTaskEnvelope(rawTask: string): { ok: true; value: TaskEnvelope } | RunnerFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawTask);
  } catch (error) {
    console.error(`Invalid task JSON: ${(error as Error).message}`);
    return { ok: false, exitCode: ExitCode.InvalidInput };
  }

  const result = validateTaskEnvelope(parsed);
  if (!result.ok) {
    console.error("Invalid task envelope.");
    printValidationErrors(result.errors);
    return { ok: false, exitCode: ExitCode.InvalidInput };
  }

  const major = result.value.protocolVersion.split(".")[0];
  if (major !== "0") {
    console.error(`Unsupported protocol major version: ${result.value.protocolVersion}`);
    return { ok: false, exitCode: ExitCode.InvalidInput };
  }

  return { ok: true, value: result.value };
}

async function resolveAgent(
  agentRef: string,
  cwd: string,
): Promise<{ ok: true; value: ResolvedAgent } | RunnerFailure> {
  const manifestPath = await resolveManifestPath(agentRef, cwd);
  if (!manifestPath) {
    console.error(`Could not find agent manifest for '${agentRef}'.`);
    return { ok: false, exitCode: ExitCode.UnsupportedTaskType };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    console.error(`Could not read agent manifest at ${manifestPath}: ${(error as Error).message}`);
    return { ok: false, exitCode: ExitCode.InvalidInput };
  }

  const result = validateAgentManifest(parsed);
  if (!result.ok) {
    console.error(`Invalid agent manifest at ${manifestPath}.`);
    printValidationErrors(result.errors);
    return { ok: false, exitCode: ExitCode.InvalidInput };
  }

  return {
    ok: true,
    value: {
      manifest: result.value,
      manifestDir: path.dirname(manifestPath),
    },
  };
}

async function resolveManifestPath(agentRef: string, cwd: string): Promise<null | string> {
  const candidates = [
    path.resolve(cwd, agentRef),
    path.resolve(cwd, "agents", agentRef),
    path.resolve(cwd, "agents", agentRef, "agent.json"),
  ];

  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) {
      const manifestPath = path.join(candidate, "agent.json");
      if (await fileExists(manifestPath)) return manifestPath;
      continue;
    }
    if (path.basename(candidate) === "agent.json") return candidate;
  }

  return null;
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

function checkAgentCompatibility(
  manifest: AgentManifest,
  task: TaskEnvelope,
): { ok: true } | RunnerFailureWithMessage {
  if (!manifest.taskTypes.includes(task.task.type)) {
    return {
      ok: false,
      exitCode: ExitCode.UnsupportedTaskType,
      message: `Agent '${manifest.name}' does not support task type '${task.task.type}'.`,
    };
  }

  const missingCapabilities = manifest.requires.filter(
    (capability) => !task.capabilities.includes(capability),
  );
  if (missingCapabilities.length > 0) {
    return {
      ok: false,
      exitCode: ExitCode.MissingCapability,
      message: `Task is missing required capabilities: ${missingCapabilities.join(", ")}`,
    };
  }

  return { ok: true };
}

async function runAgent(
  agent: ResolvedAgent,
  task: TaskEnvelope,
  rawTask: string,
): Promise<number> {
  const binaryPath = path.resolve(agent.manifestDir, agent.manifest.binary);
  const command = binaryPath.endsWith(".js") ? process.execPath : binaryPath;
  const args = binaryPath.endsWith(".js") ? [binaryPath] : [];
  const child = spawn(command, args, {
    cwd: agent.manifestDir,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutChunks: Buffer[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  child.once("spawn", () => {
    child.stdin.write(rawTask, (error) => {
      if (error) {
        console.error(`Could not write task envelope to agent stdin: ${error.message}`);
      }
      child.stdin.end();
    });
  });
  child.stdin.on("error", (error) => {
    console.error(`Could not write task envelope to agent stdin: ${error.message}`);
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      console.error(`Could not start agent '${agent.manifest.name}': ${error.message}`);
      resolve(ExitCode.GenericFailure);
    });
    child.on("close", (code, signal) => {
      if (signal) {
        console.error(`Agent '${agent.manifest.name}' exited from signal ${signal}.`);
        resolve(ExitCode.Cancelled);
        return;
      }
      resolve(code ?? ExitCode.GenericFailure);
    });
  });

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const parsed = parseNdjsonEvents(stdout);
  if (!parsed.ok) {
    for (const error of parsed.errors) console.error(error);
    return ExitCode.GenericFailure;
  }

  const stream = validateEventStream(parsed.events, exitCode);
  if (!stream.ok) {
    for (const error of stream.errors) console.error(error);
    return ExitCode.GenericFailure;
  }

  // Flight recorder: leave a task-scoped run-manifest.json next to the run's
  // artifacts so standalone runs are queryable without the orchestrator.
  // Best-effort — a manifest write failure never changes the agent's outcome.
  await writeRunManifest(agent, task, parsed.events, exitCode).catch((error) => {
    console.error(
      `run-manifest.json write failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  return exitCode;
}

/**
 * Write the task's manifest into the same directory the agents use for their
 * artifacts (ANCHORAGE_ARTIFACT_DIR, or the agents' shared tmpdir default), so
 * the manifest lands beside the run's other outputs.
 */
async function writeRunManifest(
  agent: ResolvedAgent,
  task: TaskEnvelope,
  events: Parameters<typeof buildTaskRunManifest>[0]["events"],
  exitCode: number,
): Promise<void> {
  const manifest = buildTaskRunManifest({
    task,
    agent: agent.manifest.name,
    events,
    exitCode,
    generator: "anchorage-runner",
  });
  const dir =
    process.env.ANCHORAGE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "anchorage-agent-artifacts", task.run.id);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "run-manifest.json");
  await fs.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.error(`run manifest: ${file}`);
}

function printValidationErrors(errors: readonly unknown[]): void {
  for (const error of errors) {
    console.error(JSON.stringify(error));
  }
}

interface RunnerFailure {
  ok: false;
  exitCode: number;
}

interface RunnerFailureWithMessage extends RunnerFailure {
  message: string;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
