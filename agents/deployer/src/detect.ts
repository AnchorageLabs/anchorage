/**
 * Deciding which GitHub workflow is "the deploy workflow".
 *
 * The agent dispatches whatever this picks, so a wrong pick does not fail — it
 * runs the wrong workflow against a real environment. Eligibility is decided by
 * reading each file (it must have `workflow_dispatch` and an environment input);
 * this module only decides the ORDER in which candidates are considered, which is
 * what breaks ties between two eligible files.
 *
 * Extracted from `index.ts` (nothing there was exported) so the ranking can be
 * tested without a checkout.
 */

/**
 * How strongly a filename suggests deploying. Higher wins.
 *
 * The patterns are matched against separator-delimited TOKENS, not as
 * substrings. `cd` as a substring matched any filename containing those two
 * letters — `cdn-purge.yml`, `abcd.yml` — which could rank a CDN-invalidation
 * workflow above a genuinely-unhinted `main.yml` that is the real deploy. Tokens
 * keep `cd.yml` and `deploy-cd.yml` scoring while dropping the accidents.
 *
 * `deploy` outranks the rest because it is the only unambiguous word: `release`,
 * `stage` and `ship` all name things that are sometimes deploys and sometimes not.
 */
export function score(file: string): number {
  const tokens = file
    .toLowerCase()
    .replace(/\.ya?ml$/, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (tokens.some((t) => t.includes("deploy"))) return 3;
  if (tokens.some((t) => t === "cd")) return 2;
  if (tokens.some((t) => t.includes("release") || t.includes("stage") || t.includes("ship"))) {
    return 2;
  }
  return 0;
}

/**
 * Candidate workflow files, most likely first.
 *
 * A stable sort with the filename as the tie-breaker, so two equally-scored files
 * are always considered in the same order — the same checkout must dispatch the
 * same workflow on every run, and `readdir` order is not a guarantee.
 */
export function rankWorkflowFiles(files: readonly string[]): string[] {
  return [...files].sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}
