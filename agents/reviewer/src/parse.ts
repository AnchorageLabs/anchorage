/**
 * Getting the review verdict out of the model's reply.
 *
 * The reviewer asks for a JSON object and gets JSON wrapped in whatever the model
 * felt like adding — a `<thinking>` block, a ```json fence, prose on both sides.
 * A failure here means a completed review is discarded and the run reports that
 * it could not review, so the recovery is worth more than it looks.
 *
 * Extracted from `index.ts` so it can be tested (nothing in that 988-line script
 * was exported).
 *
 * NOTE ON DUPLICATION: this balanced-brace scan is character-for-character the
 * same algorithm as the coder's `parseCoderSummary`, and `pr-opener` solves the
 * same problem DIFFERENTLY (greedy first-`{` to last-`}`). Three agents therefore
 * behave differently on identical model output. Unifying them means putting the
 * scan in `@anchorage/sdk`, which is a public-protocol change and its own
 * decision — recorded here rather than done quietly.
 */

export type JsonValue = JsonObject | JsonValue[] | boolean | null | number | string;
export type JsonObject = { [key: string]: JsonValue };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ParsedReview = { ok: false; message: string } | { ok: true; value: JsonObject };

/**
 * Parse the review object, returning WHY it failed rather than throwing.
 *
 * The message is surfaced to the run, so "did not contain a JSON object" and
 * "was not an object" and a parse error are kept distinct: they point at
 * different fixes (the model ignored the format, returned an array, or was cut
 * off).
 */
export function parseReviewJson(value: string): ParsedReview {
  const json = extractJsonObject(value);
  if (!json) return { ok: false, message: "LLM response did not contain a JSON object." };
  try {
    const parsed = JSON.parse(json);
    if (!isObject(parsed)) return { ok: false, message: "LLM review JSON was not an object." };
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, message: `LLM review JSON was invalid: ${(error as Error).message}` };
  }
}

/**
 * The first substring that is a BALANCED, parseable object.
 *
 * Scans from each `{` rather than spanning to the last `}`, because prose after
 * the object (or a second object) would make a greedy span unparseable. String
 * state and escapes are tracked so a `}` inside a value does not end the scan
 * early. A candidate that does not parse moves on to the next `{` instead of
 * giving up — that is what recovers a reply with a brace in its prose.
 */
export function extractJsonObject(value: string): null | string {
  const cleaned = value.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").replace(/```(?:json)?/g, "");
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
          const candidate = cleaned.slice(i, j + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            break; // mismatched braces inside string-like content; try next "{"
          }
        }
      }
    }
  }
  return null;
}
