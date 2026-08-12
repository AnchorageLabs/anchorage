/**
 * The plan comment the planner posts on the issue.
 *
 * This is how a human first sees what the agent intends to do, BEFORE any code
 * is written — the cheapest point at which someone can say "no, not like that".
 * So an empty section or a missing branch name is not cosmetic: it is the
 * difference between a reviewable intention and a wall of text nobody reads.
 *
 * Extracted from `index.ts` so it can be tested (nothing in that 880-line script
 * was exported), following `issue-triage/src/comment.ts`.
 */

/** Only the plan fields the comment renders. */
export interface PlanComment {
  planId: string;
  goal: string;
  branchName: string;
  implementationSteps: string[];
  acceptanceCriteria: string[];
  risks: string[];
}

export function buildPlanComment(plan: PlanComment): string {
  const lines: string[] = [];
  lines.push("## Anchorage Plan");
  lines.push("");
  lines.push(`**Goal:** ${plan.goal}`);
  lines.push(`**Branch:** \`${plan.branchName}\``);
  lines.push(`**Plan ID:** \`${plan.planId}\``);
  lines.push("");
  lines.push("### Steps");
  lines.push("");
  for (const step of plan.implementationSteps) {
    lines.push(`- ${step}`);
  }
  lines.push("");
  lines.push("### Acceptance criteria");
  lines.push("");
  for (const criterion of plan.acceptanceCriteria) {
    lines.push(`- ${criterion}`);
  }
  // Risks is conditional: a plan with no risks should not advertise an empty
  // "### Risks" heading, which reads as "we did not think about it".
  if (plan.risks.length > 0) {
    lines.push("");
    lines.push("### Risks");
    lines.push("");
    for (const risk of plan.risks) {
      lines.push(`- ${risk}`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("*Posted by [planner](https://github.com/AnchorageLabs/anchorage) agent.*");
  return lines.join("\n");
}

/** Only the envelope fields the decision needs. */
export interface PlanCommentContext {
  capabilities?: unknown;
  repository?: { owner: string; name: string } | null;
}

/**
 * Should the plan be posted as a comment on the issue?
 *
 * All four conditions are required, and the last one is the one that was missing:
 *
 *  - the run was granted `github.write` — posting without it is exceeding scope;
 *  - a token exists to post with;
 *  - the run knows which repository it is about;
 *  - **the issue number is a positive integer.**
 *
 * `issueNumber: 0` is the protocol's documented value for "there is no issue
 * yet", used by the plan-only flow (instruction-to-plan) which plans BEFORE an
 * issue exists — the planner's own `parseIssueSummary` allows it deliberately.
 * Commenting on issue #0 is a guaranteed API rejection, so without this check the
 * one flow the convention exists for was the one flow that reliably failed here.
 */
export function shouldPostPlanComment(
  ctx: PlanCommentContext,
  issueNumber: unknown,
  token: string | undefined,
): boolean {
  const hasGithubWrite =
    Array.isArray(ctx.capabilities) && ctx.capabilities.includes("github.write");
  if (!hasGithubWrite) return false;
  if (!token) return false;
  if (!ctx.repository) return false;
  return typeof issueNumber === "number" && Number.isInteger(issueNumber) && issueNumber > 0;
}
