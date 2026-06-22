import { describe, expect, it } from "vitest";
import { parsePreviewManifest, serializePreviewManifest } from "../src/manifest.js";

const valid = {
  framework: "react",
  generator: "template" as const,
  installCommand: "pnpm install",
  startCommand: "pnpm run dev",
  port: 3101,
};

describe("parsePreviewManifest", () => {
  it("round-trips a valid manifest", () => {
    const parsed = parsePreviewManifest(serializePreviewManifest(valid));
    expect(parsed).toEqual(valid);
  });

  it("accepts the llm generator", () => {
    const parsed = parsePreviewManifest(JSON.stringify({ ...valid, generator: "llm" }));
    expect(parsed?.generator).toBe("llm");
  });

  it("rejects invalid JSON", () => {
    expect(parsePreviewManifest("{not json")).toBeNull();
  });

  it("rejects an unknown generator", () => {
    expect(parsePreviewManifest(JSON.stringify({ ...valid, generator: "magic" }))).toBeNull();
  });

  it("rejects a missing/empty command", () => {
    expect(parsePreviewManifest(JSON.stringify({ ...valid, startCommand: "" }))).toBeNull();
    const { installCommand: _omit, ...withoutInstall } = valid;
    expect(parsePreviewManifest(JSON.stringify(withoutInstall))).toBeNull();
  });

  it("rejects a non-positive or non-integer port", () => {
    expect(parsePreviewManifest(JSON.stringify({ ...valid, port: 0 }))).toBeNull();
    expect(parsePreviewManifest(JSON.stringify({ ...valid, port: 3000.5 }))).toBeNull();
    expect(parsePreviewManifest(JSON.stringify({ ...valid, port: "3000" }))).toBeNull();
  });

  it("rejects a non-object", () => {
    expect(parsePreviewManifest("42")).toBeNull();
    expect(parsePreviewManifest("null")).toBeNull();
  });
});
