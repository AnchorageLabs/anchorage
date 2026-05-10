import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskEnvelope } from "../src/index.js";
import {
  ExitCode,
  eventStreamContextFromTaskEnvelope,
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

function readEventStream(relativePaths: string[]) {
  const parsed = parseNdjsonEvents(
    relativePaths.map((relativePath) => JSON.stringify(readFixture(relativePath))).join("\n"),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return parsed.events;
}

describe("protocol schema validation", () => {
  it("accepts a valid minimal task envelope", () => {
    const result = validateTaskEnvelope(
      readFixture("protocol/test-cases/valid/tasks/minimal-envelope.json"),
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
      validateAgentManifest(readFixture("protocol/test-cases/valid/manifests/minimal-agent.json"))
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

  it("rejects non-RFC3339 date-time strings", () => {
    const event = {
      ...(readFixture("protocol/test-cases/valid/events/agent-started.json") as Record<
        string,
        unknown
      >),
      timestamp: "2026-04-28",
    };

    expect(validateProtocolEvent(event).ok).toBe(false);
  });

  it("rejects event payloads that are missing type-specific fields", () => {
    for (const path of [
      "protocol/test-cases/invalid/events/agent-failed-missing-error.json",
      "protocol/test-cases/invalid/events/tool-requested-missing-tool.json",
      "protocol/test-cases/invalid/events/tool-result-missing-success.json",
      "protocol/test-cases/invalid/events/policy-requested-missing-gate.json",
      "protocol/test-cases/invalid/events/policy-resolved-missing-decision.json",
    ]) {
      expect(validateProtocolEvent(readFixture(path)).ok).toBe(false);
    }
  });
});

describe("event stream semantic validation", () => {
  it("accepts a valid completed stream", () => {
    const events = readEventStream([
      "protocol/test-cases/valid/events/agent-started.json",
      "protocol/test-cases/valid/events/tool-requested.json",
      "protocol/test-cases/valid/events/tool-result.json",
      "protocol/test-cases/valid/events/artifact-created.json",
      "protocol/test-cases/valid/events/agent-completed.json",
    ]);
    const context = eventStreamContextFromTaskEnvelope(
      readFixture("protocol/test-cases/valid/tasks/minimal-envelope.json") as TaskEnvelope,
    );

    const stream = validateEventStream(events, ExitCode.Success, context);
    expect(stream.ok).toBe(true);
  });

  it("rejects terminal event and exit-code mismatch", () => {
    const events = readEventStream([
      "protocol/test-cases/valid/events/agent-started.json",
      "protocol/test-cases/valid/events/agent-completed.json",
    ]);

    const stream = validateEventStream(events, ExitCode.GenericFailure);
    expect(stream.ok).toBe(false);
  });

  it("rejects duplicate event IDs", () => {
    const events = readEventStream([
      "protocol/test-cases/valid/events/agent-started.json",
      "protocol/test-cases/valid/events/tool-requested.json",
      "protocol/test-cases/valid/events/agent-completed.json",
    ]);
    const duplicateEvents = events.map((event, index) =>
      index === 1 ? { ...event, eventId: events[0]?.eventId ?? event.eventId } : event,
    );

    const stream = validateEventStream(duplicateEvents, ExitCode.Success);
    expect(stream.ok).toBe(false);
  });

  it("rejects events that do not match the task context", () => {
    const events = readEventStream([
      "protocol/test-cases/valid/events/agent-started.json",
      "protocol/test-cases/valid/events/agent-completed.json",
    ]);
    const context = eventStreamContextFromTaskEnvelope(
      readFixture("protocol/test-cases/valid/tasks/minimal-envelope.json") as TaskEnvelope,
    );

    const stream = validateEventStream(events, ExitCode.Success, {
      ...context,
      runId: "run_other",
    });
    expect(stream.ok).toBe(false);
  });
});
