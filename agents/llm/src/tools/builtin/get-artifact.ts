// get_artifact (Fase 3 · D2) — the escape hatch for the context budget. An agent
// receives only a budgeted slice of each prior artifact inlined in its prompt;
// when it needs the full content of one (a long issue body, the complete plan,
// a prior review), it calls get_artifact(artifactType) to pull it on demand
// instead of every prompt carrying every artifact in full. Reads the artifact's
// file:// URI from the run's prior-artifact list (ToolContext.artifacts), bounded
// so a single fetch can't blow the budget it exists to protect. Fails closed to
// a short note when the artifact isn't present or can't be read.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { JsonObject, ToolContext, ToolDefinition, ToolHandlerResult } from "../types.js";

// A single fetch is capped — get_artifact must not become a way to dump an
// unbounded blob into context. Larger artifacts are truncated with a marker.
const MAX_ARTIFACT_BYTES = 24_000;

function listAvailable(ctx: ToolContext): string {
  const types = [...new Set((ctx.artifacts ?? []).map((a) => a.artifactType))];
  return types.length > 0 ? types.join(", ") : "(none)";
}

async function getArtifactHandler(input: JsonObject, ctx: ToolContext): Promise<ToolHandlerResult> {
  const artifactType = typeof input.artifactType === "string" ? input.artifactType.trim() : "";
  if (!artifactType) {
    return {
      ok: false,
      code: "invalid_input",
      message: `get_artifact requires 'artifactType'. Available: ${listAvailable(ctx)}.`,
    };
  }

  // Most-recent match wins (later artifacts supersede earlier same-type ones).
  const matches = (ctx.artifacts ?? []).filter((a) => a.artifactType === artifactType);
  const artifact = matches[matches.length - 1];
  if (!artifact) {
    const note = `No '${artifactType}' artifact available for this run. Available: ${listAvailable(ctx)}.`;
    return { ok: true, output: note, bytesOut: note.length, meta: { found: false, artifactType } };
  }
  if (!artifact.uri.startsWith("file://")) {
    const note = `Artifact '${artifactType}' is not a local file (uri: ${artifact.uri}); cannot read.`;
    return { ok: true, output: note, bytesOut: note.length, meta: { found: false, artifactType } };
  }

  let raw: string;
  try {
    raw = await readFile(fileURLToPath(artifact.uri), "utf8");
  } catch (error) {
    const note = `Could not read '${artifactType}': ${error instanceof Error ? error.message : String(error)}.`;
    return { ok: true, output: note, bytesOut: note.length, meta: { found: false, artifactType } };
  }

  const truncated = raw.length > MAX_ARTIFACT_BYTES;
  const body = truncated ? raw.slice(0, MAX_ARTIFACT_BYTES) : raw;
  const header = `=== artifact: ${artifactType} ===\n`;
  const footer = truncated
    ? `\n… [truncated ${raw.length - MAX_ARTIFACT_BYTES} of ${raw.length} bytes]`
    : "";
  const output = `${header}${body}${footer}`;
  return {
    ok: true,
    output,
    bytesOut: output.length,
    meta: { found: true, artifactType, bytes: raw.length, truncated },
  };
}

export const getArtifactTool: ToolDefinition = {
  name: "get_artifact",
  description:
    "Fetch the FULL content of a prior-step artifact by type, on demand. Your prompt carries only a " +
    "budgeted slice of each artifact; call this when you need the complete content of one — e.g. the " +
    "full issue body, the complete implementation plan, a prior review or revision request. Pass " +
    "'artifactType' (e.g. 'issue.summary', 'implementation.plan', 'code.revision.request'). Returns a " +
    "short note (never an error) when the artifact isn't available; the note lists what is.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["artifactType"],
    properties: {
      artifactType: {
        type: "string",
        description: "The artifact type to fetch (e.g. 'issue.summary', 'implementation.plan').",
      },
    },
  },
  capability: "repo.read",
  handler: getArtifactHandler,
};
