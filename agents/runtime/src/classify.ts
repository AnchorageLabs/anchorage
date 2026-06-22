// Change classification for the visual runtime gate.
//
// The runtime gate is scoped to visual/frontend changes — the kind a human
// wants to SEE before merge. Everything else skips the gate cleanly instead of
// trying to boot the app, which for a real product (auth, external APIs, a
// database) can never come up here without its secrets. Pure functions, no I/O,
// so they're cheap to unit-test.

import path from "node:path";

const DOC_FILE_PATTERNS = [
  /\.md$/i,
  /\.mdx$/i,
  /\.markdown$/i,
  /\.rst$/i,
  /\.txt$/i,
  /\.adoc$/i,
  /^license$/i,
  /^notice$/i,
  /^authors$/i,
  /^changelog/i,
  /(^|\/)docs?\//i,
  /(^|\/)\.github\//i,
];

// Frontend/UI files whose change is something a human would want to SEE.
const VISUAL_FILE_PATTERNS = [
  /\.(tsx|jsx|vue|svelte|astro)$/i,
  /\.(css|scss|sass|less|styl|pcss)$/i,
  /\.(html?|ejs|hbs|handlebars|pug)$/i,
  /\.(svg|png|jpe?g|gif|webp|avif|ico)$/i,
  /\.(woff2?|ttf|otf|eot)$/i,
];

// Clear backend / non-UI signals. Any match means the change reaches code that
// needs the app's real runtime (DB, auth, external APIs) to exercise — which we
// can't stand up here — so it's not a visual preview no matter what else it
// touches. Checked BEFORE the visual test, so a mixed change (UI + an API route)
// is correctly treated as backend.
const BACKEND_PATH_PATTERNS = [
  /(^|\/)(api|server|backend|db|database|migrations?|prisma|drizzle|workers?|jobs?)\//i,
  /\.(server|api)\.[tj]sx?$/i,
  /(^|\/)route\.[tj]s$/i, // Next.js / Remix route handlers
  /(^|\/)middleware\.[tj]s$/i,
  /\.(sql|prisma)$/i,
  /\.(py|go|rb|java|rs|php|cs|kt|scala|ex|exs)$/i,
];

function matchesFile(file: string, patterns: RegExp[]): boolean {
  const base = path.basename(file);
  return patterns.some((pattern) => pattern.test(file) || pattern.test(base));
}

/** What kind of change this is, for deciding whether the visual gate applies. */
export type ChangeKind = "docs" | "visual" | "backend" | "non-visual";

/**
 * Classify a change set for the visual runtime gate. Docs are stripped first
 * (they never decide the kind); then any backend signal wins over visual, so a
 * mixed UI+backend change is "backend". A change with at least one visual file
 * and no backend signal is "visual"; anything left (config/tooling only) is
 * "non-visual".
 */
export function classifyChange(files: string[]): ChangeKind {
  const meaningful = files.filter((file) => !matchesFile(file, DOC_FILE_PATTERNS));
  if (meaningful.length === 0) return "docs";
  if (meaningful.some((file) => matchesFile(file, BACKEND_PATH_PATTERNS))) return "backend";
  if (meaningful.some((file) => matchesFile(file, VISUAL_FILE_PATTERNS))) return "visual";
  return "non-visual";
}

/** Human-readable reason the visual gate is being skipped for a non-visual change. */
export function skipReason(kind: Exclude<ChangeKind, "visual">, files: string[]): string {
  const n = files.length;
  switch (kind) {
    case "docs":
      return `Change touches only documentation/non-code files (${n} file(s)); nothing to run locally.`;
    case "backend":
      return "Change reaches backend/non-UI code; the runtime gate previews visual changes only and can't run this without the app's real services and secrets. Skipping the gate — the PR still opens.";
    case "non-visual":
      return `Change touches no visual/UI files (configuration or tooling only, ${n} file(s)); nothing to preview. Skipping the gate.`;
  }
}
