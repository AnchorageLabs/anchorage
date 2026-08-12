import { extractJsonObject } from "@anchorage/sdk";

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
 * The scan itself is `extractJsonObject` from `@anchorage/sdk`: three agents had
 * their own copy and two disagreed, so identical model output produced different
 * results depending on which agent received it. What stays here is this agent's
 * own vocabulary for WHY a reply was unusable, which the run surfaces.
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

export { extractJsonObject };
