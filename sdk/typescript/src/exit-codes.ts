export const ExitCode = {
  Success: 0,
  GenericFailure: 1,
  InvalidInput: 2,
  UnsupportedTaskType: 3,
  MissingCapability: 4,
  PolicyDenied: 5,
  ExternalDependencyFailure: 6,
  Timeout: 7,
  Cancelled: 8,
  PartialSuccessAttentionRequired: 9,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export function terminalEventTypeForExitCode(exitCode: number): "agent.completed" | "agent.failed" {
  return exitCode === ExitCode.Success ? "agent.completed" : "agent.failed";
}
