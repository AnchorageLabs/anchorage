// Task-scoped flight recorder: fold one agent task's protocol events into a
// run-manifest.json. This is the single-agent counterpart of the
// orchestrator's full-run manifest — `anchorage run` writes one per invocation
// so standalone runs (no orchestrator) still leave a queryable record of what
// ran, what it cost, what it touched, and how it ended. Every read is
// tolerant: agents evolve their event shapes, and a malformed field must
// degrade to null/[] rather than lose the manifest.

import type { ArtifactReference, ProtocolEvent, TaskEnvelope } from "./types.js";

export const TASK_RUN_MANIFEST_SCHEMA_VERSION = "0.1";

export interface TaskRunManifest {
  schemaVersion: typeof TASK_RUN_MANIFEST_SCHEMA_VERSION;
  scope: "task";
  generator: string;
  runId: string;
  taskId: string;
  taskType: string;
  agent: string;
  repository: { owner: string; name: string } | null;
  exitCode: number;
  timing: { startedAt: string | null; finishedAt: string | null; durationMs: number | null };
  llm: {
    provider: string | null;
    models: string[];
    inputTokens: number;
    outputTokens: number;
  } | null;
  toolCalls: {
    total: number;
    failures: number;
    byTool: Record<string, { calls: number; failures: number }>;
  };
  filesRead: string[];
  artifacts: { artifactType: string; uri: string }[];
  errors: { source: "agent.failed" | "tool.result"; code: string | null; message: string }[];
  eventCount: number;
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Token usage for the task. Tool-loop agents emit a context.snapshot progress
 * event whose totals already cover every LLM turn — prefer it. One-shot agents
 * only carry usage on the LLM tool.result. Never sum both: tool-loop agents
 * report the same totals in each.
 */
function foldLlm(events: ProtocolEvent[]): TaskRunManifest["llm"] {
  const models = new Set<string>();
  let provider: string | null = null;
  for (const e of events) {
    const data = obj(e.data);
    if (!data) continue;
    for (const container of [obj(data.input), obj(data.output)]) {
      if (!container) continue;
      const model = str(container.model);
      if (model) models.add(model);
      provider = provider ?? str(container.provider);
    }
  }

  let snapshotIn: number | null = null;
  let snapshotOut: number | null = null;
  for (const e of events) {
    const data = obj(e.data);
    if (!data || data.kind !== "context.snapshot") continue;
    snapshotIn = (snapshotIn ?? 0) + (num(data.inputTokensTotal) ?? 0);
    snapshotOut = (snapshotOut ?? 0) + (num(data.outputTokensTotal) ?? 0);
  }

  let inputTokens = snapshotIn ?? 0;
  let outputTokens = snapshotOut ?? 0;
  if (snapshotIn === null && snapshotOut === null) {
    for (const e of events) {
      if (e.type !== "tool.result") continue;
      const output = obj(obj(e.data)?.output);
      if (!output) continue;
      inputTokens += num(output.inputTokens) ?? 0;
      outputTokens += num(output.outputTokens) ?? 0;
    }
  }

  if (models.size === 0 && inputTokens === 0 && outputTokens === 0) return null;
  return { provider, models: [...models].sort(), inputTokens, outputTokens };
}

export function buildTaskRunManifest(input: {
  task: TaskEnvelope;
  agent: string;
  events: ProtocolEvent[];
  exitCode: number;
  generator: string;
}): TaskRunManifest {
  const { task, events } = input;

  const byTool: Record<string, { calls: number; failures: number }> = {};
  let toolTotal = 0;
  let toolFailures = 0;
  const filesRead = new Set<string>();
  const artifacts: { artifactType: string; uri: string }[] = [];
  const errors: TaskRunManifest["errors"] = [];

  for (const e of events) {
    const data = obj(e.data);

    if (e.type === "tool.result" && data) {
      const tool = str(data.tool) ?? "unknown";
      const entry = (byTool[tool] ??= { calls: 0, failures: 0 });
      entry.calls++;
      toolTotal++;
      if (data.success !== true) {
        entry.failures++;
        toolFailures++;
      }
      const err = obj(obj(data.output)?.error);
      if (err) {
        errors.push({
          source: "tool.result",
          code: str(err.code),
          message: str(err.message) ?? "tool failed",
        });
      }
    }

    if (data?.kind === "context.snapshot") {
      for (const f of strArray(data.filesRead)) filesRead.add(f);
    }
    if (e.type === "tool.requested" && data) {
      if (data.tool === "read_file" || data.tool === "read_repo_manifest") {
        const p = str(obj(data.input)?.path);
        if (p) filesRead.add(p);
      }
    }

    if (e.type === "artifact.created" && data) {
      const ref = data as Partial<ArtifactReference>;
      const artifactType = str(ref.artifactType);
      const uri = str(ref.uri);
      if (artifactType && uri) artifacts.push({ artifactType, uri });
    }

    if (e.type === "agent.failed") {
      const err = obj(data?.error);
      errors.push({
        source: "agent.failed",
        code: str(err?.code),
        message: str(err?.message) ?? str(e.message) ?? "agent failed",
      });
    }
  }

  let startedAt: string | null = null;
  let finishedAt: string | null = null;
  for (const e of events) {
    if (!e.timestamp) continue;
    if (startedAt === null || e.timestamp < startedAt) startedAt = e.timestamp;
    if (finishedAt === null || e.timestamp > finishedAt) finishedAt = e.timestamp;
  }
  const durationMs =
    startedAt !== null && finishedAt !== null
      ? Date.parse(finishedAt) - Date.parse(startedAt)
      : null;

  return {
    schemaVersion: TASK_RUN_MANIFEST_SCHEMA_VERSION,
    scope: "task",
    generator: input.generator,
    runId: task.run.id,
    taskId: task.task.id,
    taskType: task.task.type,
    agent: input.agent,
    repository: task.repository
      ? { owner: task.repository.owner, name: task.repository.name }
      : null,
    exitCode: input.exitCode,
    timing: {
      startedAt,
      finishedAt,
      durationMs: durationMs !== null && Number.isFinite(durationMs) ? durationMs : null,
    },
    llm: foldLlm(events),
    toolCalls: { total: toolTotal, failures: toolFailures, byTool },
    filesRead: [...filesRead].sort(),
    artifacts,
    errors,
    eventCount: events.length,
  };
}
