#!/usr/bin/env node
import { readFileSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  ExitCode,
  type ProtocolEvent,
  type TaskEnvelope,
  validateTaskEnvelope,
} from "@anchorage/sdk";

type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonObject | JsonValue[] | boolean | null | number | string;

const agentVersion = "0.1.0";
let eventSequence = 0;

async function main(): Promise<number> {
  const task = parseTask(readFileSync(0, "utf8"));
  if (!task.ok) return task.exitCode;

  if (task.value.task.type !== "deploy.watch") {
    emit(task.value, "agent.failed", "error", "Unsupported task type", {
      error: {
        code: "unsupported_task_type",
        message: `deploy-watch only supports deploy.watch, got ${task.value.task.type}`,
      },
    });
    return ExitCode.UnsupportedTaskType;
  }

  emit(task.value, "agent.started", "info", "deploy-watch started", { agentVersion });

  const deployment = parseDeployment(task.value.input.deployment ?? task.value.input);
  if (!deployment.ok) return fail(task.value, deployment);

  emit(task.value, "agent.output", "info", "Deployment status recorded", deployment.value);

  const artifact = await writeArtifact(task.value, deployment.value);
  emit(task.value, "artifact.created", "info", "Deployment record artifact created", artifact);

  if (!isSuccessfulDeployment(deployment.value.status)) {
    emit(task.value, "agent.failed", "error", "Deployment is not successful", {
      error: {
        code: "deployment_not_successful",
        message: `Deployment status is ${deployment.value.status}.`,
      },
      artifact,
    });
    return ExitCode.PartialSuccessAttentionRequired;
  }

  emit(task.value, "agent.completed", "info", "deploy-watch completed successfully", {
    status: deployment.value.status,
    artifact,
  });
  return ExitCode.Success;
}

function parseTask(rawTask: string): { ok: true; value: TaskEnvelope } | AgentFailure {
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

function parseDeployment(
  value: JsonValue | undefined,
): { ok: true; value: DeploymentRecord } | DeployFailure {
  if (!isObject(value)) {
    return failure(
      "missing_deployment",
      "deploy-watch requires input.deployment.",
      ExitCode.InvalidInput,
    );
  }

  const id = readString(value.id) ?? "deployment_local";
  const environment = readString(value.environment) ?? "unknown";
  const status = readString(value.status) ?? "unknown";

  return {
    ok: true,
    value: {
      deploymentId: id,
      environment,
      status,
      url: readString(value.url),
      sha: readString(value.sha),
      observedAt: new Date().toISOString(),
    },
  };
}

function isSuccessfulDeployment(status: string): boolean {
  return ["deployed", "success", "succeeded", "ready"].includes(status.toLowerCase());
}

async function writeArtifact(task: TaskEnvelope, record: DeploymentRecord) {
  const artifactRoot =
    process.env.ANCHORAGE_ARTIFACT_DIR ??
    path.join(os.tmpdir(), "anchorage-agent-artifacts", task.run.id);
  await fs.mkdir(artifactRoot, { recursive: true });
  const artifactPath = path.join(artifactRoot, "deployment-record.json");
  const content = `${JSON.stringify(record, null, 2)}\n`;
  await fs.writeFile(artifactPath, content, "utf8");
  return {
    artifactType: "deployment.record",
    uri: `file://${artifactPath}`,
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(content),
  };
}

function fail(task: TaskEnvelope, failureValue: DeployFailure): number {
  emit(task, "agent.failed", "error", failureValue.message, {
    error: { code: failureValue.code, message: failureValue.message },
  });
  return failureValue.exitCode;
}

function failure(code: string, message: string, exitCode: number): DeployFailure {
  return { ok: false, code, message, exitCode };
}

function readString(value: JsonValue | undefined): null | string {
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

interface AgentFailure {
  ok: false;
  exitCode: number;
}

interface DeployFailure extends AgentFailure {
  code: string;
  message: string;
}

type DeploymentRecord = ProtocolEvent["data"] & {
  deploymentId: string;
  environment: string;
  status: string;
  url: null | string;
  sha: null | string;
  observedAt: string;
};

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = ExitCode.GenericFailure;
  });
