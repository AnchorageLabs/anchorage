/**
 * Reading the smoke-check list.
 *
 * The danger here is not a crash, it is a **quiet pass**. Malformed entries used
 * to be `continue`d silently, so a list of five checks with four mistakes ran ONE
 * check and the report said `passed` — a smoke test that skipped most of its
 * checks and reported success, which is exactly the reassurance a smoke test
 * exists to refuse to give falsely.
 *
 * Parsing still keeps the valid checks (refusing the whole run over one typo would
 * be its own failure mode), but it now RETURNS what it dropped and why, so the
 * agent can say so out loud. That is the same loud-degrade shape the context-pack
 * engine and the cartographer binding preflight already use.
 *
 * Extracted from `index.ts` (nothing there was exported) so both halves — what is
 * kept and what is dropped — can be pinned.
 */

export type JsonValue = JsonObject | JsonValue[] | boolean | null | number | string;
export type JsonObject = { [key: string]: JsonValue };

export interface HttpCheckSpec {
  type: "http";
  name: string;
  url: string;
  expectedStatus: number;
}

export interface ShellCheckSpec {
  type: "shell";
  name: string;
  command: string;
  args: string[];
}

export type CheckSpec = HttpCheckSpec | ShellCheckSpec;

/** A rejected entry, with enough detail to fix it. */
export interface SkippedCheck {
  index: number;
  reason: string;
}

export interface ParsedChecks {
  checks: CheckSpec[];
  skipped: SkippedCheck[];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): null | string {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): null | number {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Parse the check list, keeping the valid entries and reporting the rest.
 *
 * The `index` in each skipped entry is its position in the caller's array, which
 * is the only durable way to point at it — a malformed entry frequently has no
 * usable name.
 */
export function parseCheckSpecs(value: unknown): ParsedChecks {
  const checks: CheckSpec[] = [];
  const skipped: SkippedCheck[] = [];
  if (!Array.isArray(value)) return { checks, skipped };

  for (const [index, candidate] of value.entries()) {
    if (!isObject(candidate)) {
      skipped.push({ index, reason: "not an object" });
      continue;
    }
    const name = readString(candidate.name) ?? `check_${checks.length + 1}`;
    const type = readString(candidate.type);

    if (type === "http") {
      const url = readString(candidate.url);
      if (!url) {
        skipped.push({ index, reason: `http check "${name}" has no url` });
        continue;
      }
      checks.push({
        type,
        name,
        url,
        expectedStatus: readNumber(candidate.expectedStatus) ?? 200,
      });
      continue;
    }

    if (type === "shell") {
      const command = readString(candidate.command);
      if (!command) {
        skipped.push({ index, reason: `shell check "${name}" has no command` });
        continue;
      }
      checks.push({
        type,
        name,
        command,
        args: Array.isArray(candidate.args) ? candidate.args.filter(isString) : [],
      });
      continue;
    }

    // An unrecognised type is named in the reason: "type must be http or shell"
    // is actionable, silently dropping it is not.
    skipped.push({
      index,
      reason: type ? `unknown check type "${type}"` : "missing check type",
    });
  }

  return { checks, skipped };
}
