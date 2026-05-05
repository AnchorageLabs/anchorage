import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ExitCode,
  parseNdjsonEvents,
  validateAgentManifest,
  validateEventStream,
  validateProtocolEvent,
  validateTaskEnvelope,
} from "../src/index.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function readFixture(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

describe("protocol schema validation", () => {
  it("accepts a valid issue.read task envelope", () => {
    const result = validateTaskEnvelope(
      readFixture("protocol/test-cases/valid/tasks/issue-read.json"),
    );

    expect(result.ok).toBe(true);
  });

  it("rejects invalid task envelopes", () => {
    const invalidProtocol = validateTaskEnvelope(
      readFixture("protocol/test-cases/invalid/tasks/invalid-protocol-version.json"),
    );
    const missingTaskType = validateTaskEnvelope(
      readFixture("protocol/test-cases/invalid/tasks/missing-task-type.json"),
    );

    expect(invalidProtocol.ok).toBe(false);
    expect(missingTaskType.ok).toBe(false);
  });

  it("accepts valid protocol events and manifests", () => {
    expect(
      validateProtocolEvent(readFixture("protocol/test-cases/valid/events/agent-started.json")).ok,
    ).toBe(true);
    expect(
      validateAgentManifest(readFixture("protocol/test-cases/valid/manifests/issue-reader.json"))
        .ok,
    ).toBe(true);
  });

  it("rejects malformed protocol events and manifests", () => {
    expect(
      validateProtocolEvent(readFixture("protocol/test-cases/invalid/events/malformed-event.json"))
        .ok,
    ).toBe(false);
    expect(
      validateAgentManifest(
        readFixture("protocol/test-cases/invalid/manifests/missing-binary.json"),
      ).ok,
    ).toBe(false);
  });
});

describe("event stream semantic validation", () => {
  it("accepts a valid completed stream", () => {
    const events = [
      readFixture("protocol/test-cases/valid/events/agent-started.json"),
      readFixture("protocol/test-cases/valid/events/artifact-created.json"),
      readFixture("protocol/test-cases/valid/events/agent-completed.json"),
    ];

    const parsed = parseNdjsonEvents(events.map((event) => JSON.stringify(event)).join("\n"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const stream = validateEventStream(parsed.events, ExitCode.Success);
    expect(stream.ok).toBe(true);
  });

  it("rejects terminal event and exit-code mismatch", () => {
    const events = [
      readFixture("protocol/test-cases/valid/events/agent-started.json"),
      readFixture("protocol/test-cases/valid/events/agent-completed.json"),
    ];

    const parsed = parseNdjsonEvents(events.map((event) => JSON.stringify(event)).join("\n"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const stream = validateEventStream(parsed.events, ExitCode.GenericFailure);
    expect(stream.ok).toBe(false);
  });
});
