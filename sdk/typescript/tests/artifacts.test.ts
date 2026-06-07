import { describe, expect, it } from "vitest";
import {
  buildRevisionRequest,
  REVISION_REQUEST_ARTIFACT_TYPE,
  type RevisionRequest,
} from "../src/index.js";

describe("buildRevisionRequest", () => {
  const base: RevisionRequest = {
    fromAgent: "tester",
    reason: "test_failed",
    summary: "1 of 2 commands failed",
    failures: [{ name: "typecheck", command: "pnpm typecheck", details: "TS2345: ..." }],
  };

  it("exposes the canonical artifact type", () => {
    expect(REVISION_REQUEST_ARTIFACT_TYPE).toBe("code.revision.request");
  });

  it("preserves the provided fields", () => {
    const result = buildRevisionRequest(base);
    expect(result).toEqual(base);
  });

  it("omits optional failure fields when absent", () => {
    const result = buildRevisionRequest({
      ...base,
      failures: [{ name: "lint" }],
    });
    expect(result.failures[0]).toEqual({ name: "lint" });
    expect("command" in result.failures[0]).toBe(false);
    expect("details" in result.failures[0]).toBe(false);
  });

  it("truncates failure details to the configured bound", () => {
    const result = buildRevisionRequest(
      { ...base, failures: [{ name: "test", details: "x".repeat(100) }] },
      { maxDetailLength: 10 },
    );
    expect(result.failures[0].details).toBe("x".repeat(10));
  });

  it("truncates failure details to the default bound", () => {
    const result = buildRevisionRequest({
      ...base,
      failures: [{ name: "test", details: "y".repeat(5000) }],
    });
    expect(result.failures[0].details).toHaveLength(4000);
  });
});
