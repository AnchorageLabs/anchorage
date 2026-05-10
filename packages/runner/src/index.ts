#!/usr/bin/env node
/**
 * @anchorage/runner — CLI entry point
 *
 * Usage:
 *   anchorage run <agent-path> < task.json
 *
 * Reads a task envelope from stdin, validates it and the agent manifest,
 * spawns the agent, streams NDJSON protocol events, enforces ordering rules,
 * and exits with the protocol-agreed exit code.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

// ---------------------------------------------------------------------------
// Minimal inline schemas / validators
// We define lightweight Zod-free validators here so the runner compiles even
// if @anchorage/sdk does not yet export every schema.  When the SDK grows the
// full set of validators, replace these with SDK imports.
// ---------------------------------------------------------------------------

type TaskEnvelope = {
  id: string;
  type: string;
  capabilities?: string[];
  payload?: unknown;
  [key: string]: unknown;
};

type AgentManifest = {
  name: string;
  version: string;
  taskTypes: string[];
  capabilities?: string[];
  [key: string]: unknown;
};

type ProtocolEvent = {
  type: string;
  [key: string]: unknown;
};

/** Terminal event types per the Anchorage protocol contract (ADR-0003). */
const TERMINAL_EVENT_TYPES = new Set(["task.complete", "task.failed", "task.cancelled"]);

/** Success terminal events → runner must exit 0. */
const SUCCESS_TERMINAL_TYPES = new Set(["task.complete"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(message: string, code = 1): never {
  process.stderr.write(`[anchorage-runner] ERROR: ${message}\n`);
  process.exit(code);
}

function info(message: string): void {
  process.stderr.write(`[anchorage-runner] ${message}\n`);
}

function validateTaskEnvelope(raw: unknown): TaskEnvelope {
  if (typeof raw !== "object" || raw === null) {
    die("Task envelope must be a JSON object.");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["id"] !== "string" || obj["id"].trim() === "") {
    die('Task envelope must have a non-empty string field "id".');
  }
  if (typeof obj["type"] !== "string" || obj["type"].trim() === "") {
    die('Task envelope must have a non-empty string field "type".');
  }
  if (obj["capabilities"] !== undefined && !Array.isArray(obj["capabilities"])) {
    die('Task envelope field "capabilities" must be an array if present.');
  }
  return obj as unknown as TaskEnvelope;
}

function validateAgentManifest(raw: unknown, manifestPath: string): AgentManifest {
  if (typeof raw !== "object" || raw === null) {
    die(`Agent manifest at ${manifestPath} must be a JSON object.`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["name"] !== "string" || obj["name"].trim() === "") {
    die(`Agent manifest at ${manifestPath} must have a non-empty string field "name".`);
  }
  if (typeof obj["version"] !== "string") {
    die(`Agent manifest at ${manifestPath} must have a string field "version".`);
  }
  if (!Array.isArray(obj["taskTypes"])) {
    die(`Agent manifest at ${manifestPath} must have an array field "taskTypes".`);
  }
  return obj as unknown as AgentManifest;
}

function validateProtocolEvent(raw: unknown, lineNumber: number): ProtocolEvent {
  if (typeof raw !== "object" || raw === null) {
    die(`NDJSON line ${lineNumber}: event must be a JSON object, got: ${JSON.stringify(raw)}`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["type"] !== "string" || obj["type"].trim() === "") {
    die(`NDJSON line ${lineNumber}: event must have a non-empty string field "type".`);
  }
  return obj as unknown as ProtocolEvent;
}

// ---------------------------------------------------------------------------
// Stdin reader
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Manifest discovery
// ---------------------------------------------------------------------------

function loadManifest(agentPath: string): AgentManifest {
  const candidates = [
    path.join(path.dirname(agentPath), "manifest.json"),
    path.join(agentPath, "manifest.json"),
    path.join(path.dirname(agentPath), "..", "manifest.json"),
  ];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) {
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
      } catch (err) {
        die(`Failed to parse agent manifest at ${resolved}: ${String(err)}`);
      }
      info(`Loaded agent manifest from ${resolved}`);
      return validateAgentManifest(raw, resolved);
    }
  }

  die(
    `Could not find manifest.json adjacent to agent at ${agentPath}. ` +
      `Searched: ${candidates.map((c) => path.resolve(c)).join(", ")}`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. Parse argv:  anchorage run <agent-path>
  // -------------------------------------------------------------------------
  const argv = process.argv.slice(2);

  // Support both:
  //   anchorage run <agent-path>
  //   anchorage <agent-path>   (direct invocation)
  let agentArg: string | undefined;
  if (argv[0] === "run") {
    agentArg = argv[1];
  } else {
    agentArg = argv[0];
  }

  if (!agentArg) {
    die(
      "Usage: anchorage run <agent-path> < task.json\n" +
        "  <agent-path>  Path to the agent executable or directory containing manifest.json"
    );
  }

  const agentPath = path.resolve(agentArg);

  if (!fs.existsSync(agentPath)) {
    die(`Agent not found at path: ${agentPath}`);
  }

  // -------------------------------------------------------------------------
  // 2. Read and validate task envelope from stdin
  // -------------------------------------------------------------------------
  info("Reading task envelope from stdin…");
  const stdinText = await readStdin();

  if (stdinText.trim() === "") {
    die("No task envelope received on stdin. Pipe a JSON task envelope.");
  }

  let rawTask: unknown;
  try {
    rawTask = JSON.parse(stdinText);
  } catch (err) {
    die(`Failed to parse task envelope as JSON: ${String(err)}`);
  }

  const task = validateTaskEnvelope(rawTask);
  info(`Task envelope validated: id=${task.id} type=${task.type}`);

  // -------------------------------------------------------------------------
  // 3. Load and validate agent manifest
  // -------------------------------------------------------------------------
  const manifest = loadManifest(agentPath);
  info(`Agent manifest validated: name=${manifest.name} version=${manifest.version}`);

  // -------------------------------------------------------------------------
  // 4. Check task type is supported
  // -------------------------------------------------------------------------
  if (!manifest.taskTypes.includes(task.type)) {
    die(
      `Task type "${task.type}" is not supported by agent "${manifest.name}". ` +
        `Supported types: ${manifest.taskTypes.join(", ")}`
    );
  }

  // -------------------------------------------------------------------------
  // 5. Check required capabilities
  // -------------------------------------------------------------------------
  const requiredCaps: string[] = Array.isArray(task.capabilities) ? (task.capabilities as string[]) : [];
  const grantedCaps: string[] = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];

  const missingCaps = requiredCaps.filter((cap) => !grantedCaps.includes(cap));
  if (missingCaps.length > 0) {
    die(
      `Agent "${manifest.name}" is missing required capabilities: ${missingCaps.join(", ")}. ` +
        `Granted capabilities: ${grantedCaps.length > 0 ? grantedCaps.join(", ") : "(none)"}`
    );
  }

  // -------------------------------------------------------------------------
  // 6. Spawn agent process
  // -------------------------------------------------------------------------
  info(`Spawning agent: ${agentPath}`);

  const agentProc = spawn(agentPath, [], {
    stdio: ["pipe", "pipe", "inherit"],
    shell: false,
  });

  // Write task envelope to agent stdin
  agentProc.stdin.write(JSON.stringify(task));
  agentProc.stdin.end();

  // -------------------------------------------------------------------------
  // 7. Stream and validate NDJSON events from agent stdout
  // -------------------------------------------------------------------------
  const rl = readline.createInterface({ input: agentProc.stdout!, crlfDelay: Infinity });

  let lineNumber = 0;
  let terminalEventSeen = false;
  let terminalEventType: string | null = null;
  const postTerminalLines: string[] = [];

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === "") continue; // skip blank lines

    lineNumber++;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      die(`NDJSON line ${lineNumber}: failed to parse as JSON: ${String(err)}\n  Line content: ${trimmed}`);
    }

    const event = validateProtocolEvent(parsed, lineNumber);
    const isTerminal = TERMINAL_EVENT_TYPES.has(event.type);

    if (terminalEventSeen) {
      // Any event after a terminal event is a protocol violation
      postTerminalLines.push(trimmed);
      process.stderr.write(
        `[anchorage-runner] PROTOCOL VIOLATION: event received after terminal event "${terminalEventType}": ${trimmed}\n`
      );
    } else {
      info(`Event [${lineNumber}]: ${event.type}`);
      if (isTerminal) {
        terminalEventSeen = true;
        terminalEventType = event.type;
        info(`Terminal event received: ${event.type}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 8. Wait for agent process to exit
  // -------------------------------------------------------------------------
  const agentExitCode = await new Promise<number>((resolve) => {
    agentProc.on("close", (code) => resolve(code ?? 1));
    agentProc.on("error", (err) => {
      process.stderr.write(`[anchorage-runner] Agent process error: ${String(err)}\n`);
      resolve(1);
    });
  });

  info(`Agent process exited with code ${agentExitCode}`);

  // -------------------------------------------------------------------------
  // 9. Enforce post-stream protocol rules
  // -------------------------------------------------------------------------

  // 9a. At least one terminal event must have been emitted
  if (!terminalEventSeen) {
    die(
      `Agent "${manifest.name}" exited without emitting a terminal event. ` +
        `Expected one of: ${[...TERMINAL_EVENT_TYPES].join(", ")}`
    );
  }

  // 9b. Post-terminal events are a protocol violation → exit non-zero
  if (postTerminalLines.length > 0) {
    die(
      `Agent "${manifest.name}" emitted ${postTerminalLines.length} event(s) after terminal event "${terminalEventType}". ` +
        "This violates the Anchorage protocol (ADR-0003)."
    );
  }

  // 9c. Exit-code agreement
  //   success terminal event → runner must exit 0
  //   failure/cancelled terminal event → runner must exit non-zero
  const isSuccessTerminal = SUCCESS_TERMINAL_TYPES.has(terminalEventType!);

  if (isSuccessTerminal && agentExitCode !== 0) {
    // Agent claimed success but exited non-zero — treat as failure
    die(
      `Protocol mismatch: agent emitted "${terminalEventType}" (success) but exited with code ${agentExitCode}. ` +
        "Treating as failure."
    );
  }

  if (!isSuccessTerminal && agentExitCode === 0) {
    // Agent claimed failure but exited 0 — treat as failure
    die(
      `Protocol mismatch: agent emitted "${terminalEventType}" (failure/cancelled) but exited with code 0. ` +
        "Treating as failure."
    );
  }

  // All checks passed — exit with the agent's exit code
  info(`Runner exiting with code ${agentExitCode}`);
  process.exit(agentExitCode);
}

main().catch((err: unknown) => {
  process.stderr.write(`[anchorage-runner] Unhandled error: ${String(err)}\n`);
  process.exit(1);
});
