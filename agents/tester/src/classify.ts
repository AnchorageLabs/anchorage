/**
 * Telling "the tests failed" apart from "the environment could not run them".
 *
 * This distinction is the whole value of the tester agent, and getting it wrong
 * is expensive in both directions:
 *
 *  - environment noise reported as a code failure burns a retry — and then the
 *    coder is handed a "fix this" instruction about code that was never broken;
 *  - a real failure reported as blocked lets broken code proceed toward merge.
 *
 * So the rule is narrow on purpose: a non-zero exit is a TEST failure unless the
 * output matches something that could only come from the machine.
 *
 * Extracted from `index.ts` (nothing there was exported) so the patterns can be
 * exercised against real failure text without running a build.
 */

export interface CommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface EnvironmentVerdict {
  blocked: boolean;
  reason?: string;
}

/**
 * Output that can only mean the worker, not the code.
 *
 * Order matters: the first match wins, so the specific patterns (Docker, Gradle,
 * Make) sit before the generic "not found" they would otherwise be swallowed by,
 * and the caller gets a reason worth reading.
 *
 * The version-skew group at the end is the subtle one. A repo pinning a newer
 * toolchain than the worker has cannot be built here, and that is not a defect in
 * the repo — treating it as a test failure would send the coder chasing a
 * manifest it should not change.
 */
export const ENVIRONMENT_FAILURE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /docker: (?:command )?not found|cannot connect to the docker daemon|is the docker daemon running/i,
    "Docker is not available in the worker",
  ],
  [/make: \*\*\* .*Error 127/i, "a Make target invoked a tool that is not installed"],
  [/\bgradlew\b.*(?:not found|permission denied)/i, "the Gradle wrapper could not run"],
  [
    /command not found|: not found|executable file not found/i,
    "a required command is not installed",
  ],
  [/no such file or directory/i, "a required file or tool is missing"],
  [
    /connection refused|ECONNREFUSED|could not connect to server|could not translate host/i,
    "a required service/database was not reachable",
  ],
  [
    /invalid go version|errors parsing go\.mod|go: .*requires go >=|must match format|go: downloading go\d/i,
    "the worker's Go toolchain version cannot build this module",
  ],
  [
    /unsupported engine|the engine "node" is incompatible|EBADENGINE|requires node|nvmrc|volta/i,
    "the worker's runtime version does not match what the project requires",
  ],
  [
    /SDK not found|JAVA_HOME|could not determine java version|unsupported class file major version/i,
    "the worker's JDK version does not match what the project requires",
  ],
];

/**
 * Was this failure the environment's fault?
 *
 * A zero exit is never blocked — success is success, whatever got printed along
 * the way. Exit 127 is always the environment: the shell could not find the
 * command, so nothing was tested. Otherwise the combined output is matched
 * against {@link ENVIRONMENT_FAILURE_PATTERNS}, and anything unmatched stays a
 * genuine test failure.
 *
 * Both streams are searched because tools disagree about which one a fatal error
 * belongs on, and a rule that only read stderr would miss half of them.
 */
export function classifyEnvironment(result: CommandOutput): EnvironmentVerdict {
  if (result.exitCode === 0) return { blocked: false };
  const text = `${result.stderr}\n${result.stdout}`;
  if (result.exitCode === 127) {
    return { blocked: true, reason: "command exited 127 (not found / unavailable)" };
  }
  for (const [pattern, reason] of ENVIRONMENT_FAILURE_PATTERNS) {
    if (pattern.test(text)) return { blocked: true, reason };
  }
  return { blocked: false };
}
