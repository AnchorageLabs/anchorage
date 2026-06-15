// Lossless terminal-output normalization for tool results (the safe subset of
// the trs "generic fallback"). Every transform here removes bytes a terminal
// would have rendered away or never shown — never semantic content:
//
//   1. ANSI/VT escape sequences (colors, cursor moves, OSC titles) — pure
//      presentation; the model gains nothing from them.
//   2. Carriage-return overwrites — a progress line printed as
//      "10%\r50%\r100%\n" is three frames of an animation the user only ever
//      saw the last of; we keep the final frame, matching what a TTY displays.
//   3. Runs of blank lines collapsed to a single blank line.
//   4. Trailing whitespace per line.
//
// The result is what a human would have seen on screen, so it is lossless to
// the model. Opt out per run with ANCHORAGE_SHELL_CLEAN=false.

// Matches CSI/SGR sequences (ESC= "[" ... final byte), OSC sequences
// (... terminated by BEL=), and the 8-bit CSI introducer (). Built
// from a string of \u escapes so no literal control bytes live in the source.
// Deliberately broad — anything in this family is terminal control, not data.
const ANSI_PATTERN = new RegExp(
  "[\\u001b\\u009b][[\\]()#;?]*" +
    "(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007" +
    "|(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~])",
  "g",
);

/** Resolve carriage-return overwrites within a single line to its final frame. */
function resolveCarriageReturns(line: string): string {
  if (!line.includes("\r")) return line;
  // The visible content of a TTY line after CR overwrites is the segment after
  // the last carriage return. (Partial-overwrite edge cases are rare in tool
  // output and never carry signal a coding agent needs.)
  const segments = line.split("\r");
  return segments[segments.length - 1] ?? line;
}

/**
 * Normalize captured terminal output. Returns the cleaned string. A no-op
 * (returns the input) when `enabled` is false, so the caller can gate on env
 * without branching at every call site.
 */
export function cleanTerminalOutput(text: string, enabled = true): string {
  if (!enabled || text.length === 0) return text;

  const withoutAnsi = text.replace(ANSI_PATTERN, "");

  const lines = withoutAnsi
    .split("\n")
    .map((line) => resolveCarriageReturns(line).replace(/\s+$/, ""));

  // Collapse 3+ consecutive blank lines (after trimming) to one blank line.
  const out: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.length === 0) {
      blankRun++;
      if (blankRun > 1) continue;
    } else {
      blankRun = 0;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Whether terminal-output cleaning is enabled for this run (default on). */
export function shellCleanEnabled(env: Record<string, string>): boolean {
  return !/^(false|0|no|off)$/i.test((env.ANCHORAGE_SHELL_CLEAN ?? "").trim());
}
