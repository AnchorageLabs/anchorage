export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonObject | JsonValue[] | boolean | null | number | string;

export interface ArtifactReference {
  artifactType: string;
  uri: string;
  mediaType?: string;
  sizeBytes?: number;
  sha256?: string;
}

export interface AgentManifest {
  name: string;
  version: string;
  protocolVersion: string;
  description?: string;
  taskTypes: string[];
  inputs?: string[];
  outputs?: string[];
  requires: string[];
  binary: string;
  timeout?: number;
}

export interface ProtocolEvent {
  protocolVersion: string;
  eventId: string;
  runId: string;
  taskId: string;
  timestamp: string;
  type:
    | "agent.started"
    | "agent.progress"
    | "agent.heartbeat"
    | "agent.completed"
    | "agent.failed"
    | "agent.output"
    | "artifact.created"
    | "policy.requested"
    | "policy.resolved"
    | "tool.requested"
    | "tool.result";
  level: "debug" | "error" | "info" | "warn";
  message: string;
  data: JsonObject;
}

export interface TaskEnvelope {
  protocolVersion: string;
  task: {
    id: string;
    type: string;
    createdAt: string;
    deadlineAt?: null | string;
  };
  run: {
    id: string;
    attempt: number;
    correlationId: string;
  };
  actor: {
    requestedBy: string;
    agent: string;
  };
  repository?: {
    provider: "github";
    owner: string;
    name: string;
    defaultBranch: string;
  };
  input: JsonObject;
  capabilities: string[];
  policy?: JsonObject & {
    humanApprovalRequired?: boolean;
    maxDurationSeconds?: number;
  };
  context?: JsonObject & {
    parentTaskId?: null | string;
    priorArtifacts?: ArtifactReference[];
  };
  secrets?: Record<string, { $ref: string }>;
}

export type EventType = ProtocolEvent["type"];
export type EventLevel = ProtocolEvent["level"];
