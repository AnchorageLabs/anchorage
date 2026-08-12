/**
 * Did the deployment actually go live?
 *
 * This verdict is what a later step reads to decide whether the change is
 * deployed. It is an ALLOWLIST rather than a list of failures on purpose: a
 * status this agent has never seen — a new platform's wording, a typo, an empty
 * string — must not count as a success, because "we do not recognise this" is not
 * evidence that anything shipped.
 *
 * Extracted from `index.ts` (nothing there was exported) so the vocabulary can be
 * pinned without a deployment.
 */

/** Statuses that mean the deployment is live. Case-insensitive. */
export const SUCCESSFUL_DEPLOYMENT_STATUSES: readonly string[] = [
  "deployed",
  "ready",
  "succeeded",
  "success",
];

export function isSuccessfulDeployment(status: string): boolean {
  return SUCCESSFUL_DEPLOYMENT_STATUSES.includes(status.toLowerCase());
}
