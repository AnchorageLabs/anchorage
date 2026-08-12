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

import { parseModelJsonObject } from "@anchorage/sdk";

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
 * The scan is `parseModelJsonObject` from `@anchorage/sdk` — three agents had
 * their own copy of it and two disagreed.
 *
 * Falls back to the first 800 characters as the summary when nothing parses,
 * which is the honest degrade: a truncated or chatty reply still reports what the
 * model said instead of turning into silence (#209).
 */
export function parseCoderSummary(text: string): CoderSummary {
  const fallback: CoderSummary = {
    summary: text.slice(0, 800),
    commandsSuggested: [],
    risks: [],
  };
  const parsed = parseModelJsonObject(text);
  if (!parsed.ok) return fallback;
  const summary =
    typeof parsed.value.summary === "string" ? parsed.value.summary : fallback.summary;
  const commandsSuggested = Array.isArray(parsed.value.commandsSuggested)
    ? parsed.value.commandsSuggested.filter(isString)
    : [];
  const risks = Array.isArray(parsed.value.risks) ? parsed.value.risks.filter(isString) : [];
  return { summary, commandsSuggested, risks };
}
