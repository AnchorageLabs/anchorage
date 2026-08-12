/**
 * What the pull request actually says.
 *
 * The model is asked for a JSON object of PR sections and this module turns that
 * — or the absence of it — into a title and a markdown body. Everything here is
 * user-visible: it is the first thing a human reads on an agent's work, so a
 * blank section or a title that is really a paragraph is a product defect, not a
 * cosmetic one.
 *
 * Extracted from `index.ts` for the same reason as the coder's `summary.ts`:
 * `pr-opener` is the third-highest-churn file in the `agents/` tree (40 commits,
 * 3,149 lines changed) and nothing in its 950-line script was exported, so none
 * of this could be tested. The extraction surface came from
 * `cartographer deps agents/pr-opener/src/index.ts:361-480`.
 */

export type JsonValue = JsonObject | JsonValue[] | boolean | null | number | string;
export type JsonObject = { [key: string]: JsonValue };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The model's proposed PR sections. Only `title` and `why` are required. */
export interface PrContentRaw {
  title: string;
  summary: string;
  why: string;
  what: string;
  how: string;
  notes: string;
}

/** The coder's delivery record, as far as PR content is concerned. */
export interface CodeChangeInput {
  branchName: string;
  changedFiles: string[];
  summary: string;
  issueNumber: null | number;
}

export interface PrContent {
  title: string;
  body: string;
}

/** Walk a nested key path, returning a string or null — never throwing. */
export function readString(obj: JsonObject | null, ...keys: string[]): string | null {
  let current: JsonValue | undefined = obj as JsonValue;
  for (const key of keys) {
    if (!isObject(current)) return null;
    current = current[key];
  }
  return typeof current === "string" ? current : null;
}

/**
 * Pull the PR sections out of the model's reply.
 *
 * Spans the OUTERMOST braces (first `{` to last `}`) rather than scanning for a
 * balanced object, which is a deliberate difference from the coder's parser: here
 * the whole reply is expected to be the object, and being greedy tolerates a
 * trailing fence or stray prose after it.
 *
 * `title` and `why` are required and type-checked. Returning null when either is
 * missing is what routes the caller to `fallbackPrContent` — a PR with an empty
 * title is worse than a PR with a mechanical one.
 */
export function parsePrContentJson(text: string): PrContentRaw | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.title !== "string" || typeof parsed.why !== "string") return null;
    return parsed as PrContentRaw;
  } catch {
    return null;
  }
}

/**
 * Render the model's sections into the PR body.
 *
 * Every section has a fallback, so no heading is ever followed by whitespace:
 * an empty `## Why` reads as a broken template, and a reviewer who sees one
 * stops trusting the rest. `Notes` is the one optional section — it is omitted
 * entirely rather than filled with a placeholder, because there is no honest
 * default for "anything else worth knowing".
 */
export function assemblePrContent(
  content: PrContentRaw,
  codeChange: CodeChangeInput,
  requestedByDisplay: string | null,
): PrContent {
  const lines: string[] = [];

  lines.push("## Summary");
  lines.push("");
  lines.push(content.summary?.trim() || content.why?.trim() || "See below.");
  lines.push("");

  lines.push("## Why");
  lines.push("");
  lines.push(content.why?.trim() || "Resolves the issue.");
  lines.push("");

  lines.push("## What");
  lines.push("");
  lines.push(content.what?.trim() || changedFilesList(codeChange.changedFiles));
  lines.push("");

  lines.push("## How");
  lines.push("");
  lines.push(content.how?.trim() || codeChange.summary || "See changed files.");
  lines.push("");

  if (content.notes?.trim()) {
    lines.push("## Notes");
    lines.push("");
    lines.push(content.notes.trim());
    lines.push("");
  }

  if (codeChange.issueNumber) {
    lines.push(`Closes #${codeChange.issueNumber}`);
    lines.push("");
  }

  lines.push("---");
  if (requestedByDisplay) lines.push(`Requested by: ${requestedByDisplay}`);
  lines.push("*Opened by [pr-opener](https://github.com/AnchorageLabs/anchorage) agent.*");

  return { title: content.title.trim(), body: lines.join("\n") };
}

/**
 * The PR body when there is no usable model output — no key, a refusal, or
 * unparseable JSON. Mechanical but complete: it still states what changed and
 * still closes the issue, because a PR that silently omits `Closes #N` leaves an
 * issue open after the work merged.
 */
export function fallbackPrContent(
  codeChangeResult: CodeChangeInput,
  requestedByDisplay: string | null,
): PrContent {
  const title = buildFallbackTitle(codeChangeResult);
  const lines: string[] = [];

  lines.push("## Summary");
  lines.push("");
  lines.push(codeChangeResult.summary || "Automated PR opened by pr-opener agent.");
  lines.push("");

  lines.push("## What");
  lines.push("");
  lines.push(changedFilesList(codeChangeResult.changedFiles));
  lines.push("");

  if (codeChangeResult.issueNumber) {
    lines.push(`Closes #${codeChangeResult.issueNumber}`);
    lines.push("");
  }

  lines.push("---");
  if (requestedByDisplay) lines.push(`Requested by: ${requestedByDisplay}`);
  lines.push("*Opened by [pr-opener](https://github.com/AnchorageLabs/anchorage) agent.*");

  return { title, body: lines.join("\n") };
}

/**
 * A title with no model to write one, in descending order of usefulness: the
 * coder's first summary line, then the issue number, then the branch name
 * de-slugged.
 *
 * The 60-character ceiling on the summary line is why the branch fallback
 * exists at all — a coder summary that opens with a paragraph would otherwise
 * become an unreadable title, and GitHub does not wrap them.
 */
export function buildFallbackTitle(codeChange: CodeChangeInput): string {
  if (codeChange.summary) {
    const first = (codeChange.summary.split("\n")[0] ?? "").trim();
    if (first.length > 0 && first.length <= 60) return first;
  }
  if (codeChange.issueNumber) return `Fix issue #${codeChange.issueNumber}`;
  return (
    codeChange.branchName
      .replace(/^(feature|fix|chore|refactor|docs)\//i, "")
      .replaceAll(/[-_]/g, " ")
      .trim() || `Code changes on ${codeChange.branchName}`
  );
}

/** The changed-file list, or an honest sentence when there is none. */
export function changedFilesList(files: string[]): string {
  if (files.length === 0) return "No files changed.";
  return files.map((f) => `- \`${f}\``).join("\n");
}
