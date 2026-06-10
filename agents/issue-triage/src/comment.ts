// Pure comment rendering, split from index.ts so tests can import it without
// triggering the agent's stdin-driven main().

// Per-issue (not per-run) marker: retries and re-runs converge on one comment.
export const TRIAGE_COMMENT_MARKER = "<!-- anchorage:triage -->";

export interface TriageCommentInfo {
  scope: string;
  type: string;
  priority: string;
  readiness: string;
  agentEligible: boolean;
  duplicateOf: null | number;
  questions: string[];
  reasoning: string;
}

export function triageCommentBody(triage: TriageCommentInfo): string {
  const lines = [
    TRIAGE_COMMENT_MARKER,
    "### Triage",
    "",
    "| Scope | Type | Priority | Readiness |",
    "|---|---|---|---|",
    `| ${triage.scope} | ${triage.type} | ${triage.priority} | ${triage.readiness} |`,
    "",
  ];
  if (triage.duplicateOf !== null) {
    lines.push(`This issue appears to duplicate #${triage.duplicateOf}.`, "");
  } else if (triage.readiness === "needs-detail" && triage.questions.length > 0) {
    lines.push("More detail is needed before work can start. Could you clarify:", "");
    for (const question of triage.questions) lines.push(`- [ ] ${question}`);
    lines.push("");
  } else if (triage.agentEligible) {
    lines.push("This issue is ready for autonomous handling — proceeding to planning.", "");
  } else {
    lines.push("This issue is not currently eligible for autonomous handling.", "");
  }
  if (triage.reasoning.length > 0) lines.push(triage.reasoning);
  return lines.join("\n");
}
