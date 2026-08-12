/**
 * The title and description of the bitbucket pull/merge request.
 *
 * Extracted from `index.ts` (nothing there was exported) so the rendering can be
 * tested without a token or a network. The logic is intentionally the same in
 * `bitbucket-pr-opener` and `gitlab-pr-opener` — the only difference is the
 * attribution line — and both differ from the GitHub `pr-opener`, which has its
 * own section set and a 60-character title ceiling rather than 72.
 */

export interface CodeChangeView {
  branchName: string;
  changedFiles: string[];
  summary: string;
  issueNumber: null | number;
}

/**
 * A title, in descending order of usefulness: the coder's first summary line,
 * then the issue number, then the branch name de-slugged.
 *
 * The 72-character ceiling is why the later fallbacks exist at all — a summary
 * that opens with a paragraph would otherwise become an unreadable title, and
 * forges do not wrap them.
 */
export function buildTitle(change: CodeChangeView): string {
  const first = (change.summary.split("\n")[0] ?? "").trim();
  if (first.length > 0 && first.length <= 72) return first;
  if (change.issueNumber) return `Resolve issue #${change.issueNumber}`;
  return (
    change.branchName
      .replace(/^(feature|fix|chore|refactor|docs)\//i, "")
      .replaceAll(/[-_]/g, " ")
      .trim() || `Changes on ${change.branchName}`
  );
}

/**
 * The description. Both sections always render: an empty summary falls back to a
 * sentence and an empty file list says so, because a heading followed by nothing
 * reads as a broken template and a reviewer who sees one stops trusting the rest.
 */
export function buildDescription(change: CodeChangeView): string {
  const lines: string[] = ["## Summary", "", change.summary || "Automated change.", ""];
  lines.push("## Changed files", "");
  lines.push(
    change.changedFiles.length
      ? change.changedFiles.map((f) => `- \`${f}\``).join("\n")
      : "No files changed.",
  );
  lines.push("", "---", "*Opened by the anchorage bitbucket-pr-opener agent.*");
  return lines.join("\n");
}
