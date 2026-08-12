/**
 * Turning a GitHub issue into the `issue.summary` artifact.
 *
 * Every downstream agent plans, codes and reviews from this shape, so a field that
 * arrives as `null` where a string was expected does not fail here — it fails two
 * agents later, far from the cause. The normalisation is therefore total: every
 * field has a defined type on the way out.
 *
 * Extracted from `index.ts` (nothing there was exported) so the mapping can be
 * tested against the shapes GitHub actually returns.
 */

export type JsonValue = JsonObject | JsonValue[] | boolean | null | number | string;
export type JsonObject = { [key: string]: JsonValue };

/** The subset of GitHub's issue payload this artifact is built from. */
export interface GitHubIssueView {
  number: number;
  title: string;
  state: string;
  body?: null | string;
  html_url: string;
  user?: { login: string } | null;
  /** GitHub returns either bare strings or label objects, in the same array. */
  labels: Array<string | { name?: null | string }>;
}

export interface IssueSummaryArtifact {
  /** The artifact rides in a protocol event, whose data is an open JSON object. */
  [key: string]: JsonValue;
  issueNumber: number;
  title: string;
  repository: string;
  state: string;
  labels: string[];
  body: string;
  url: string;
  author: null | string;
}

/**
 * Normalise the label array.
 *
 * GitHub's REST payload mixes bare strings and `{ name }` objects in the same
 * array — the shape depends on how the label was attached — and an object's `name`
 * can be absent. Anything that does not resolve to a non-empty string is dropped
 * rather than passed on as `null`, because a downstream `labels.includes(...)`
 * would then compare against a hole.
 */
export function normalizeLabels(labels: GitHubIssueView["labels"]): string[] {
  return labels
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

/**
 * Build the artifact.
 *
 * `body` becomes `""` rather than staying null: an issue with no description is
 * ordinary, and every consumer would otherwise need its own null check. `author`
 * stays nullable on purpose — a deleted account genuinely has no login, and
 * inventing one would be a false fact.
 */
export function toIssueSummary(
  issue: GitHubIssueView,
  repository: { owner: string; name: string },
): IssueSummaryArtifact {
  return {
    issueNumber: issue.number,
    title: issue.title,
    repository: `${repository.owner}/${repository.name}`,
    state: issue.state,
    labels: normalizeLabels(issue.labels),
    body: issue.body ?? "",
    url: issue.html_url,
    author: issue.user?.login ?? null,
  };
}
