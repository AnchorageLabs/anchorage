// Cache for a repo's working isolated-preview harness. Once the deterministic
// template or the LLM gets a preview up, we record how — so the next run on the
// same repo reuses it (skipping the LLM) instead of rediscovering from scratch.
// Mirrors the `.anchorage/runtime.json` strategy cache. Pure parse/serialize so
// it's cheap to unit-test; the file I/O lives in index.ts.

export type HarnessGenerator = "template" | "llm";

export interface PreviewManifest {
  /** Detected framework, for display and to confirm the cache still fits. */
  framework: string;
  /** Who produced the harness: a deterministic template or the LLM. */
  generator: HarnessGenerator;
  /** Install command, run with cwd = the harness dir (.anchorage/preview). */
  installCommand: string;
  /** Long-running dev-server command, run detached with cwd = the harness dir. */
  startCommand: string;
  /** Port the harness binds to. */
  port: number;
}

/** File name (under `.anchorage/`) where the working harness recipe is cached. */
export const PREVIEW_MANIFEST_FILE = "preview.json";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Parse + validate a cached manifest. Returns null on anything malformed. */
export function parsePreviewManifest(raw: string): PreviewManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const m = parsed as Record<string, unknown>;
  if (m.generator !== "template" && m.generator !== "llm") return null;
  if (!isNonEmptyString(m.framework)) return null;
  if (!isNonEmptyString(m.installCommand)) return null;
  if (!isNonEmptyString(m.startCommand)) return null;
  if (typeof m.port !== "number" || !Number.isInteger(m.port) || m.port <= 0) return null;
  return {
    framework: m.framework,
    generator: m.generator,
    installCommand: m.installCommand,
    startCommand: m.startCommand,
    port: m.port,
  };
}

export function serializePreviewManifest(manifest: PreviewManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
