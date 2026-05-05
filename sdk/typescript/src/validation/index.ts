import type { AgentManifest, ArtifactReference, ProtocolEvent, TaskEnvelope } from "../types.js";
import { validateWithSchema } from "./validator.js";

export function validateArtifactReference(value: unknown) {
  return validateWithSchema<ArtifactReference>(
    "https://anchorage.dev/schemas/artifact-reference.schema.json",
    value,
  );
}

export function validateAgentManifest(value: unknown) {
  return validateWithSchema<AgentManifest>(
    "https://anchorage.dev/schemas/agent-manifest.schema.json",
    value,
  );
}

export function validateProtocolEvent(value: unknown) {
  return validateWithSchema<ProtocolEvent>(
    "https://anchorage.dev/schemas/protocol-event.schema.json",
    value,
  );
}

export function validateTaskEnvelope(value: unknown) {
  return validateWithSchema<TaskEnvelope>(
    "https://anchorage.dev/schemas/task-envelope.schema.json",
    value,
  );
}
