import { ExitCode, terminalEventTypeForExitCode } from "../exit-codes.js";
import type { ProtocolEvent, TaskEnvelope } from "../types.js";
import { validateProtocolEvent } from "../validation/index.js";
import { isTerminalEventType } from "./event-types.js";

export type EventStreamValidationResult =
  | { ok: true; events: ProtocolEvent[] }
  | { ok: false; errors: string[] };

export interface EventStreamValidationContext {
  protocolVersion?: string;
  runId?: string;
  taskId?: string;
}

export function eventStreamContextFromTaskEnvelope(
  envelope: TaskEnvelope,
): Required<EventStreamValidationContext> {
  return {
    protocolVersion: envelope.protocolVersion,
    runId: envelope.run.id,
    taskId: envelope.task.id,
  };
}

export function parseNdjsonEvents(ndjson: string): EventStreamValidationResult {
  const events: ProtocolEvent[] = [];
  const errors: string[] = [];

  const lines = ndjson
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      errors.push(`line ${index + 1}: invalid JSON: ${(error as Error).message}`);
      continue;
    }

    const result = validateProtocolEvent(parsed);
    if (result.ok) {
      events.push(result.value);
    } else {
      errors.push(`line ${index + 1}: invalid protocol event`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, events };
}

export function validateEventStream(
  events: readonly ProtocolEvent[],
  exitCode: number,
  context: EventStreamValidationContext = {},
): EventStreamValidationResult {
  const errors: string[] = [];

  if (events.length === 0) {
    errors.push("event stream must contain at least one event");
    return { ok: false, errors };
  }

  const firstEvent = events[0];
  if (!firstEvent || firstEvent.type !== "agent.started") {
    errors.push("first event must be agent.started");
  }

  const expectedProtocolVersion = context.protocolVersion ?? firstEvent?.protocolVersion;
  const expectedRunId = context.runId ?? firstEvent?.runId;
  const expectedTaskId = context.taskId ?? firstEvent?.taskId;
  const eventIds = new Set<string>();

  for (const event of events) {
    if (eventIds.has(event.eventId)) {
      errors.push(`duplicate eventId: ${event.eventId}`);
    }
    eventIds.add(event.eventId);

    if (event.protocolVersion !== expectedProtocolVersion) {
      errors.push(`event ${event.eventId} protocolVersion must match the stream context`);
    }
    if (event.runId !== expectedRunId) {
      errors.push(`event ${event.eventId} runId must match the stream context`);
    }
    if (event.taskId !== expectedTaskId) {
      errors.push(`event ${event.eventId} taskId must match the stream context`);
    }
  }

  const terminalEvents = events.filter((event) => isTerminalEventType(event.type));
  if (terminalEvents.length !== 1) {
    errors.push("event stream must contain exactly one terminal event");
  }

  const lastEvent = events.at(-1);
  const terminalEvent = terminalEvents[0];
  if (terminalEvent && lastEvent && terminalEvent.eventId !== lastEvent.eventId) {
    errors.push("terminal event must be the last event");
  }

  if (
    !Number.isInteger(exitCode) ||
    exitCode < ExitCode.Success ||
    exitCode > ExitCode.PartialSuccessAttentionRequired
  ) {
    errors.push("exit code must be in the Anchorage protocol range 0-9");
  }

  if (terminalEvent && terminalEvent.type !== terminalEventTypeForExitCode(exitCode)) {
    errors.push("terminal event type must agree with exit code");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, events: [...events] };
}
