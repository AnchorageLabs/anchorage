#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  type AgentManifest,
  ExitCode,
  type TaskEnvelope,
  parseNdjsonEvents,
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

  return runAgent(agent.value, rawTask);
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

async function runAgent(agent: ResolvedAgent, rawTask: string): Promise<number> {
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

  return exitCode;
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
