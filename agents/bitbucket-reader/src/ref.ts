/**
 * Turning a human-written issue reference into a Bitbucket identifier.
 *
 * Getting this wrong does not fail loudly — it reads the WRONG issue, and the
 * coder then implements something nobody asked for. So the rule is: parse the
 * forms people actually write, and return null rather than guess.
 *
 * Extracted from `index.ts` (nothing there was exported) so the accepted forms
 * can be pinned without a token or a network.
 */

export interface RepositoryHint {
  owner: string;
  name: string;
}

export interface IssueRef {
  repo: string;
  id: number;
}

/**
 * Accepted forms:
 *
 *   - a full Bitbucket issue URL
 *   - `owner/name#123` — an explicit project and number
 *   - `123` and `#123` — a number, resolved against the run's repository
 *
 * `#123` is accepted deliberately: it is the most natural way to write an issue
 * reference and it used to be REJECTED while the bare `123` worked, so an
 * orchestrator or a person writing the obvious thing got "could not parse the
 * reference" instead of the issue. An empty project prefix falls back to the
 * repository the run is already about, which is the only thing it could mean.
 *
 * Anything else returns null. A reference we cannot read is not a reference we
 * should guess at.
 */
export function parseIssueRef(
  value: unknown,
  repository: RepositoryHint | null | undefined,
): IssueRef | null {
  const fallback = repository ? `${repository.owner}/${repository.name}` : null;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const candidate = value.trim();

  const urlMatch = candidate.match(/bitbucket\.org\/([^/]+\/[^/]+)\/issues\/(\d+)/i);
  if (urlMatch?.[1] && urlMatch[2]) {
    return { repo: urlMatch[1], id: Number(urlMatch[2]) };
  }
  // `[^#]*` rather than `.+?` so the prefix may be EMPTY (the `#123` form).
  const hashMatch = candidate.match(/^(?:([^#]*)#)?(\d+)$/);
  if (hashMatch?.[2]) {
    // `||`, not `??`: an empty prefix is present-but-empty and must still fall
    // back to the run's repository.
    const repo = hashMatch[1] || fallback;
    if (!repo) return null;
    return { repo, id: Number(hashMatch[2]) };
  }
  return null;
}
