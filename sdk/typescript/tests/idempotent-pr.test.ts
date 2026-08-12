import { describe, expect, it } from "vitest";
import { resolveOrCreatePr } from "../src/idempotent-pr.js";

// Opening a pull request without opening it twice. A run can be retried, resumed
// or salvaged, so the branch it pushes may already have an open PR from the
// previous attempt — and a second one splits review across two threads.
//
// The three reference PR-openers had drifted apart on this: GitHub looked before
// creating, Bitbucket and GitLab only looked after a create failed, and did it as
// `findOpen().catch(() => null)` so "no PR" and "the lookup broke" were the same
// answer.

const PR = { id: 7, url: "https://host/pr/7" };

describe("resolveOrCreatePr", () => {
  it("reuses an existing PR instead of creating a second one", async () => {
    let created = false;
    const out = await resolveOrCreatePr({
      findOpen: async () => PR,
      create: async () => {
        created = true;
        return PR;
      },
    });
    expect(out).toEqual({ reused: true, pr: PR });
    expect(created).toBe(false); // the whole point
  });

  it("creates when there is genuinely no open PR", async () => {
    const out = await resolveOrCreatePr({ findOpen: async () => null, create: async () => PR });
    expect(out).toEqual({ created: true, pr: PR });
  });

  it("the pre-check fails OPEN — a lookup outage must not stop a PR being opened", async () => {
    // Worst case is a duplicate, and the recovery path below still catches that.
    // Refusing to create would strand finished work behind an unrelated outage.
    const notified: string[] = [];
    const out = await resolveOrCreatePr({
      findOpen: async () => {
        throw new Error("502 from the forge");
      },
      create: async () => PR,
      onPreCheckFailed: (m) => notified.push(m),
    });
    expect(out).toEqual({ created: true, pr: PR });
    // Degraded, but visibly so.
    expect(notified).toEqual(["502 from the forge"]);
  });

  it("recovers when create fails because the PR already exists", async () => {
    // The race: a concurrent attempt created it, or our own pre-check failed open.
    let calls = 0;
    const out = await resolveOrCreatePr({
      findOpen: async () => (calls++ === 0 ? null : PR),
      create: async () => {
        throw new Error("400: a pull request already exists for this branch");
      },
    });
    expect(out).toEqual({ reused: true, pr: PR });
  });

  it("reports create-failed when the PR really does not exist", async () => {
    const out = await resolveOrCreatePr({
      findOpen: async () => null,
      create: async () => {
        throw new Error("401 unauthorized");
      },
    });
    expect(out).toEqual({ kind: "create-failed", failure: "401 unauthorized" });
  });

  it("says BOTH failed rather than implying no PR exists", async () => {
    // The expensive case the old `.catch(() => null)` hid: a transient lookup
    // failure while a PR does exist made the agent report create_failed on work
    // that had actually succeeded. "May exist and we could not check" is a
    // different operational state from "there is no PR".
    const out = await resolveOrCreatePr({
      findOpen: async () => {
        throw new Error("503 from the forge");
      },
      create: async () => {
        throw new Error("400 create rejected");
      },
    });
    expect(out).toMatchObject({ kind: "create-failed" });
    if ("failure" in out) {
      expect(out.failure).toContain("400 create rejected");
      expect(out.failure).toContain("503 from the forge");
      expect(out.failure).toContain("a PR may exist");
    }
  });

  it("calls onReuse on both reuse paths, so the event is emitted either way", async () => {
    const seen: unknown[] = [];
    await resolveOrCreatePr({
      findOpen: async () => PR,
      create: async () => PR,
      onReuse: (pr) => seen.push(pr),
    });
    let calls = 0;
    await resolveOrCreatePr({
      findOpen: async () => (calls++ === 0 ? null : PR),
      create: async () => {
        throw new Error("exists");
      },
      onReuse: (pr) => seen.push(pr),
    });
    expect(seen).toEqual([PR, PR]);
  });

  it("never throws, whatever the callbacks do", async () => {
    await expect(
      resolveOrCreatePr({
        findOpen: async () => {
          throw new Error("a");
        },
        create: async () => {
          throw new Error("b");
        },
      }),
    ).resolves.toMatchObject({ kind: "create-failed" });
  });

  it("a non-Error throw is still reported readably", async () => {
    const out = await resolveOrCreatePr({
      findOpen: async () => null,
      create: async () => {
        throw "a bare string";
      },
    });
    expect(out).toEqual({ kind: "create-failed", failure: "a bare string" });
  });
});
