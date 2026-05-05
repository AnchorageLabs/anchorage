export const lifecycleEventTypes = [
  "agent.started",
  "agent.progress",
  "agent.heartbeat",
  "agent.completed",
  "agent.failed",
] as const;

export const terminalEventTypes = ["agent.completed", "agent.failed"] as const;

export function isTerminalEventType(type: string): type is (typeof terminalEventTypes)[number] {
  return terminalEventTypes.includes(type as (typeof terminalEventTypes)[number]);
}
