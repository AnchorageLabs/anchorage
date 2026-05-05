import agentManifestSchemaJson from "@anchorage/protocol/schemas/agent-manifest.schema.json" with {
  type: "json",
};
import artifactReferenceSchemaJson from "@anchorage/protocol/schemas/artifact-reference.schema.json" with {
  type: "json",
};
import protocolEventSchemaJson from "@anchorage/protocol/schemas/protocol-event.schema.json" with {
  type: "json",
};
import taskEnvelopeSchemaJson from "@anchorage/protocol/schemas/task-envelope.schema.json" with {
  type: "json",
};

export const artifactReferenceSchema = artifactReferenceSchemaJson;
export const agentManifestSchema = agentManifestSchemaJson;
export const protocolEventSchema = protocolEventSchemaJson;
export const taskEnvelopeSchema = taskEnvelopeSchemaJson;

export const protocolSchemas = [
  artifactReferenceSchema,
  agentManifestSchema,
  protocolEventSchema,
  taskEnvelopeSchema,
] as const;
