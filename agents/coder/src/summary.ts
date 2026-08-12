/**
 * Parsing the coder's own final report.
 *
 * The model is asked for a JSON object at the end of the loop, and what actually
 * arrives is JSON somewhere inside prose, often wrapped in a fenced block, often
 * preceded by a `<thinking>` block, and sometimes cut off mid-token by a length
 * limit. This module turns whatever came back into the three fields the
 * `code.change` artifact needs, and never throws.
 *
 * Extracted from `index.ts` so it can be tested. It is the highest-churn file in
 * the whole `agents/` tree (77 commits, 3,812 lines changed, 4 authors) and had
 * no tests at all, because nothing in that 1,600-line script was exported —
 * the code was not reachable from a test, which is why "add tests" had never
 * happened. Follows `issue-triage/src/comment.ts`, the one agent module already
 * split out this way.
 *
 * Two shipped bugs came from this area and are pinned by the tests beside it:
 * a length-truncated turn being reported as an empty "no changes" (#209), and
 * commits the model made during the loop not counting as delivered work (#202).
 */

export type JsonValue = JsonObject | JsonValue[] | boolean | null | number | string;
export type JsonObject = { [key: string]: JsonValue };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string that carries something — empty strings are not values worth keeping. */
export function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export interface CoderSummary {
  summary: string;
  commandsSuggested: string[];
  risks: string[];
}

/**
 * Pull the report out of the model's final message.
 *
 * Scans for the first `{` that opens a BALANCED object and parses that, rather
 * than regex-matching or trusting a fence: a brace-counting scan is what
 * survives prose on both sides, nested objects, and braces inside string values
 * (string state and escapes are tracked, so `{"a": "}"}` does not end early).
 *
 * Falls back to the first 800 characters as the summary when nothing parses,
 * which is the honest degrade — a truncated or chatty reply still reports what
 * the model said instead of turning into silence.
 */
export function parseCoderSummary(text: string): CoderSummary {
  const fallback: CoderSummary = {
    summary: text.slice(0, 800),
    commandsSuggested: [],
    risks: [],
  };
  const cleaned = text.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").replace(/```(?:json)?/g, "");
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < cleaned.length; j++) {
      const ch = cleaned[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(cleaned.slice(i, j + 1));
            if (!isObject(parsed)) break;
            const summary = typeof parsed.summary === "string" ? parsed.summary : fallback.summary;
            const commandsSuggested = Array.isArray(parsed.commandsSuggested)
              ? parsed.commandsSuggested.filter(isString)
              : [];
            const risks = Array.isArray(parsed.risks) ? parsed.risks.filter(isString) : [];
            return { summary, commandsSuggested, risks };
          } catch {
            break;
          }
        }
      }
    }
  }
  return fallback;
}
