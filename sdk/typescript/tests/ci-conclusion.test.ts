import { describe, expect, it } from "vitest";
import {
  BLOCKING_CHECK_CONCLUSIONS,
  checkConclusionBlocks,
  checkRunIsPending,
  commitStatusBlocks,
  PASSING_CHECK_CONCLUSIONS,
} from "../src/ci-conclusion.js";

// One vocabulary for "is this GitHub check conclusion a pass". Two agents
// classified the same thing and DISAGREED: `ci-watcher` counted `action_required`
// as a failure, `merge-gate` did not — so a check demanding human intervention
// read as success and the PR merged. The watcher said CI failed and the gate
// merged it anyway, on the same PR.

describe("checkConclusionBlocks", () => {
  it("blocks the conclusions that are not evidence the code is good", () => {
    for (const conclusion of ["failure", "cancelled", "timed_out"]) {
      expect(checkConclusionBlocks(conclusion), conclusion).toBe(true);
    }
  });

  it("blocks action_required — the clearest possible 'not yet'", () => {
    // The divergence this file exists to end.
    expect(checkConclusionBlocks("action_required")).toBe(true);
  });

  it("blocks stale — it belongs to a superseded commit", () => {
    expect(checkConclusionBlocks("stale")).toBe(true);
  });

  it("lets through the deliberate non-blocking outcomes", () => {
    // `neutral` and `skipped` are a workflow saying "this did not apply here" —
    // an answer, not an absence. Blocking on them would strand green PRs.
    for (const conclusion of ["success", "neutral", "skipped"]) {
      expect(checkConclusionBlocks(conclusion), conclusion).toBe(false);
    }
  });

  it("does NOT block on null — a running check is pending, not failed", () => {
    expect(checkConclusionBlocks(null)).toBe(false);
    expect(checkConclusionBlocks(undefined)).toBe(false);
  });

  it("blocks an UNKNOWN conclusion, because GitHub can add one", () => {
    // Fail-closed on the vocabulary itself. If a conclusion GitHub introduces
    // later defaulted to a pass, an unreviewed state would merge — so passing
    // conclusions are listed explicitly rather than inferred from "not blocking".
    for (const conclusion of ["some_future_conclusion", "", "SUCCESS", "Success"]) {
      expect(checkConclusionBlocks(conclusion), JSON.stringify(conclusion)).toBe(true);
    }
  });

  it("the two lists are disjoint and complete for today's vocabulary", () => {
    // If a conclusion ever appeared in both, the answer would depend on
    // evaluation order rather than on meaning.
    for (const c of BLOCKING_CHECK_CONCLUSIONS) {
      expect(PASSING_CHECK_CONCLUSIONS).not.toContain(c);
    }
    const known = [...BLOCKING_CHECK_CONCLUSIONS, ...PASSING_CHECK_CONCLUSIONS].sort();
    expect(known).toEqual(
      [
        "action_required",
        "cancelled",
        "failure",
        "neutral",
        "skipped",
        "stale",
        "success",
        "timed_out",
      ].sort(),
    );
  });
});

describe("checkRunIsPending", () => {
  it("recognises every in-flight status", () => {
    for (const status of ["queued", "in_progress", "waiting"]) {
      expect(checkRunIsPending(status), status).toBe(true);
    }
  });

  it("a completed run is not pending", () => {
    for (const status of ["completed", null, undefined, ""]) {
      expect(checkRunIsPending(status), String(status)).toBe(false);
    }
  });
});

describe("commitStatusBlocks", () => {
  it("failure and error block; anything else does not", () => {
    expect(commitStatusBlocks("failure")).toBe(true);
    expect(commitStatusBlocks("error")).toBe(true);
    for (const state of ["success", "pending", null, undefined]) {
      expect(commitStatusBlocks(state), String(state)).toBe(false);
    }
  });
});
