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
