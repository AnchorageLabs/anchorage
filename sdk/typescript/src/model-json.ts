/**
 * Recovering a JSON object from an LLM reply.
 *
 * Every agent that asks a model for structured output has to solve the same
 * problem: the reply is JSON *somewhere inside* prose, often wrapped in a
 * ```json fence, often preceded by a `<thinking>` block, and sometimes followed
 * by more chat. Three reference agents had each solved it separately, and
 * **two of the three implementations disagreed**, so identical model output
 * produced different results depending on which agent received it.
 *
 * This is the one implementation. It lives in the SDK because "how do I get my
 * object back out of a model reply" is a problem every agent author has, not an
 * Anchorage-internal detail — an agent written by someone else needs it just as
 * much as ours do.
 *
 * ## Why the balanced scan, and not the simpler span
 *
 * The obvious implementation is "first `{` to last `}`". It was in use, and it
 * is worse in a way that costs real output. Measured on the same inputs:
 *
 * | reply | balanced scan | first-`{`-to-last-`}` |
 * |---|---|---|
 * | `{"a":1} note: use { braces } carefully` | recovers | **fails** |
 * | `{"a":1} {"b":2}` | recovers the first | **fails** |
 * | `starts with { and then {"real":1}` | recovers | **fails** |
 * | `<thinking>maybe {x}</thinking>{"a":1}` | recovers | **fails** |
 *
 * The span form fails in four cases and wins in none, and every one of those
 * failures is a model reply a person would call correct. In `pr-opener` it meant
 * a model that reasoned out loud with braces lost its whole PR description and
 * the user got a mechanically generated title instead — silently, because a
 * failed parse is indistinguishable from a model that ignored the format.
 */

/**
 * The first substring of `text` that is a balanced, parseable JSON object, or
 * null.
 *
 * Scans from each `{` in turn. A candidate that does not parse is abandoned and
 * the search moves to the next `{`, which is what recovers a reply whose prose
 * happens to contain a brace. String state and escapes are tracked, so a `}`
 * inside a string value does not end the object early.
 *
 * `<thinking>` blocks and markdown fences are stripped first: models emit them
 * despite system-prompt instructions, and a `<thinking>` block containing braces
 * is exactly the case that breaks the naive span.
 *
 * Returns the raw substring rather than a parsed value on purpose — a caller
 * that needs to distinguish "no object present" from "object present but
 * invalid" can only do that if the two stages stay separate.
 */
export function extractJsonObject(text: string): null | string {
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
          const candidate = cleaned.slice(i, j + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            break; // not a real object here — try the next "{"
          }
        }
      }
    }
  }
  return null;
}

export type ModelJsonResult =
  | { ok: false; reason: "invalid"; message: string }
  | { ok: false; reason: "no-object"; message: string }
  | { ok: true; value: Record<string, unknown> };

/**
 * `extractJsonObject` plus the parse, with the failure kept specific.
 *
 * The two reasons are distinguished because they point at different fixes and
 * agents surface them to a run: `no-object` means the model ignored the format,
 * `invalid` means what looked like an object would not parse (usually a truncated
 * reply). Collapsing them into one "could not parse" makes the run report
 * useless for diagnosis.
 *
 * Never throws.
 */
export function parseModelJsonObject(text: string): ModelJsonResult {
  const candidate = extractJsonObject(text);
  if (candidate === null) {
    return { ok: false, reason: "no-object", message: "reply did not contain a JSON object" };
  }
  try {
    const parsed = JSON.parse(candidate);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: "no-object", message: "reply did not contain a JSON object" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false,
      reason: "invalid",
      message: `reply JSON was invalid: ${(error as Error).message}`,
    };
  }
}
