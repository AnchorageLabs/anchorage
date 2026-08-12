/**
 * The closing comment on the issue — the last thing anyone reads about a run.
 *
 * Whoever filed the issue may see nothing else about the work: not the PR
 * description, not the test report, not the run view. So the links matter more
 * here than anywhere: this comment is the index into everything the run produced,
 * and a section silently omitted is evidence nobody will go looking for.
 *
 * Extracted from `index.ts` (nothing there was exported) so the rendering can be
 * tested without an Octokit or a run.
 */

export interface IssueCloseComment {
  summary: null | string;
  prUrl: null | string;
  commitSha: null | string;
  testReportUri: null | string;
  ciReportUri: null | string;
  deploymentUri: null | string;
  smokeTestUri: null | string;
  artifacts: string[];
}

/**
 * A URL is left bare so the reader can click it; anything else is code-quoted so
 * a commit sha or a `file://` path survives markdown intact rather than being
 * mangled into a link or having characters eaten.
 */
export function formatValue(value: string): string {
  return value.startsWith("http") ? value : `\`${value}\``;
}

/**
 * Render the summary comment.
 *
 * The `Links` and `Artifacts` sections are both conditional and both filtered:
 * an entry with an empty or non-string value is dropped rather than rendered as
 * `- Commit: ` with nothing after it, and a section with no surviving entries is
 * omitted whole rather than left as a bare heading. A heading with nothing under
 * it reads as "the run produced nothing here", which is a different and usually
 * false claim.
 *
 * The summary falls back to a plain sentence: a run that finished deserves to say
 * so even when no agent wrote a description.
 */
export function buildComment(input: IssueCloseComment): string {
  const lines: string[] = [];
  lines.push("## Anchorage Run Summary");
  lines.push("");
  lines.push(input.summary ?? "Workflow completed successfully.");
  lines.push("");

  const details = [
    ["Pull request", input.prUrl],
    ["Commit", input.commitSha],
    ["Test report", input.testReportUri],
    ["CI report", input.ciReportUri],
    ["Deployment", input.deploymentUri],
    ["Smoke test", input.smokeTestUri],
  ].filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
  );

  if (details.length > 0) {
    lines.push("## Links");
    lines.push("");
    for (const [label, value] of details) lines.push(`- ${label}: ${formatValue(value)}`);
    lines.push("");
  }

  if (input.artifacts.length > 0) {
    lines.push("## Artifacts");
    lines.push("");
    for (const artifact of input.artifacts) lines.push(`- ${formatValue(artifact)}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("*Closed by [issue-closer](https://github.com/AnchorageLabs/anchorage) agent.*");
  return lines.join("\n");
}
