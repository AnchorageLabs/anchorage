/**
 * The issue text this agent actually files.
 *
 * Whatever comes out of here becomes a real GitHub issue that a human reads and a
 * planner plans from, so the two failure directions both matter: a malformed model
 * reply must not open an empty or half-written issue, and a fallback must not
 * silently lose what the user asked for.
 *
 * Extracted from `index.ts` (nothing there was exported) so both paths can be
 * tested without a model or a token.
 */
import { parseModelJsonObject } from "@anchorage/sdk";

export interface IssueDraft {
  title: string;
  body: string;
  labels: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The model's draft, or null if it is not usable.
 *
 * Title and body are both REQUIRED and both trimmed: an issue with a blank title
 * or an empty body is worse than the mechanical fallback, because it looks like a
 * real issue and carries nothing. Returning null is what routes the caller there.
 *
 * The JSON scan itself is `parseModelJsonObject` from `@anchorage/sdk` — this file
 * held the fourth copy in the fleet, and its greedy variant lost the whole draft
 * whenever prose, a second object, or a stray brace surrounded the JSON.
 */
export function parseIssueDraft(text: string): IssueDraft | null {
  const result = parseModelJsonObject(text);
  if (!result.ok) return null;
  const parsed: unknown = result.value;
  if (!isObject(parsed)) return null;
  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  if (!title || !body) return null;
  const labels = Array.isArray(parsed.labels)
    ? parsed.labels.filter((l): l is string => typeof l === "string" && l.length > 0)
    : [];
  return { title, body, labels };
}

/** Longest title we will file; GitHub does not wrap them in list views. */
export const MAX_FALLBACK_TITLE = 80;

/**
 * The issue to file when there is no usable model draft — no key, a refusal, or
 * an unparseable reply.
 *
 * Two properties carry the weight. It **says** exploration did not complete, so a
 * reader knows the issue is thinner than usual rather than assuming the agent had
 * nothing to say. And it includes the instruction **verbatim**, so the one thing
 * that definitely came from the user survives even when everything else failed.
 */
export function fallbackDraft(instruction: string): IssueDraft {
  const firstLine =
    instruction
      .split("\n")
      .map((line) => line.trim().replace(/^#+\s*/, ""))
      .find((line) => line.length > 0) ?? "Automated change request";
  const title =
    firstLine.length > MAX_FALLBACK_TITLE
      ? `${firstLine.slice(0, MAX_FALLBACK_TITLE - 3)}…`
      : firstLine;
  const body = [
    "## Problem / Goal",
    "",
    "Created directly from the user's instruction (full repository exploration was not completed).",
    "",
    "## Instruction (verbatim)",
    "",
    instruction,
    "",
    "## Acceptance criteria",
    "",
    "- [ ] The change described in the instruction above is implemented.",
    "- [ ] The project builds and existing tests pass.",
  ].join("\n");
  return { title, body, labels: [] };
}
