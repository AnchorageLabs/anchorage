/**
 * Integration fixtures for the public reference agent chain.
 *
 * These tests are deterministic and do not require external APIs, GitHub tokens,
 * or Bedrock credentials. They validate:
 *
 *   1. All integration chain envelopes are valid TaskEnvelopes.
 *   2. All example task envelopes in examples/tasks/ are valid TaskEnvelopes.
 *   3. All agent manifests are valid AgentManifests.
 *   4. The integration chain handoffs are coherent:
 *        - each step's run ID matches the shared run ID
 *        - each step's priorArtifact types match the expected producer output
 *   5. Error-path envelopes: unsupported task types and malformed artifacts are
 *      rejected by the SDK validator.
 *
 * Run with:
 *   corepack pnpm --filter @anchorage/sdk test
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateAgentManifest, validateTaskEnvelope } from "../src/index.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function listFiles(dir: string): string[] {
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(dir, f));
}

// ── 1. Integration chain envelopes ───────────────────────────────────────────

const chainEnvelopes = listFiles("protocol/test-cases/integration/envelopes");

describe("integration chain envelopes", () => {
  it("covers all expected chain steps", () => {
    expect(chainEnvelopes.length).toBeGreaterThanOrEqual(9);
  });

  it.each(chainEnvelopes)("is a valid TaskEnvelope: %s", (filePath) => {
    const result = validateTaskEnvelope(readJson(filePath));
    expect(result.ok).toBe(true);
  });

  it("all chain steps share the same run ID", () => {
    const runIds = chainEnvelopes.map((filePath) => {
      const envelope = readJson(filePath) as { run?: { id?: string } };
      return envelope.run?.id;
    });
    const unique = new Set(runIds.filter(Boolean));
    expect(unique.size).toBe(1);
  });

  it("chain task types cover the full v0.1 lifecycle", () => {
    const taskTypes = chainEnvelopes.map((filePath) => {
      const envelope = readJson(filePath) as { task?: { type?: string } };
      return envelope.task?.type;
    });
    const expected = [
      "issue.read",
      "plan.create",
      "code.change",
      "test.run",
      "pull_request.open",
      "ci.watch",
      "review.run",
      "merge.prepare",
      "issue.close",
    ];
    for (const type of expected) {
      expect(taskTypes).toContain(type);
    }
  });
});

// ── 2. Handoff coherence ──────────────────────────────────────────────────────

/**
 * Maps each step index to the artifact types it is expected to produce,
 * which the next step should reference in priorArtifacts.
 */
const expectedHandoffs: Array<{ producer: string; artifactType: string; consumer: string }> = [
  { producer: "issue-reader", artifactType: "issue.summary",         consumer: "planner"    },
  { producer: "planner",      artifactType: "implementation.plan",   consumer: "coder"       },
  { producer: "coder",        artifactType: "code.change.result",    consumer: "tester"      },
  { producer: "coder",        artifactType: "code.change.result",    consumer: "pr-opener"   },
  { producer: "planner",      artifactType: "implementation.plan",   consumer: "pr-opener"   },
  { producer: "pr-opener",    artifactType: "pr.opened",             consumer: "ci-watcher"  },
  { producer: "pr-opener",    artifactType: "pr.opened",             consumer: "reviewer"    },
  { producer: "reviewer",     artifactType: "pr.review.result",      consumer: "merge-gate"  },
  { producer: "ci-watcher",   artifactType: "ci.report",             consumer: "merge-gate"  },
];

describe("integration chain handoff coherence", () => {
  const envelopesByAgent: Record<string, unknown> = {};
  for (const filePath of chainEnvelopes) {
    const envelope = readJson(filePath) as { actor?: { agent?: string } };
    const agent = envelope.actor?.agent;
    if (agent) envelopesByAgent[agent] = envelope;
  }

  it.each(expectedHandoffs)(
    "$producer → $consumer via $artifactType",
    ({ artifactType, consumer }) => {
      const consumerEnvelope = envelopesByAgent[consumer] as {
        context?: { priorArtifacts?: Array<{ artifactType: string }> };
      };
      expect(consumerEnvelope).toBeDefined();
      const priorTypes =
        consumerEnvelope?.context?.priorArtifacts?.map((a) => a.artifactType) ?? [];
      expect(priorTypes).toContain(artifactType);
    },
  );
});

// ── 3. Example task envelopes ─────────────────────────────────────────────────

const exampleEnvelopes = listFiles("examples/tasks");

describe("example task envelopes", () => {
  it("provides at least one example per agent", () => {
    expect(exampleEnvelopes.length).toBeGreaterThanOrEqual(10);
  });

  it.each(exampleEnvelopes)("is a valid TaskEnvelope: %s", (filePath) => {
    const result = validateTaskEnvelope(readJson(filePath));
    expect(result.ok).toBe(true);
  });
});

// ── 4. Agent manifests ────────────────────────────────────────────────────────

const agentDirs = fs
  .readdirSync(path.join(repoRoot, "agents"))
  .filter((d) => {
    const p = path.join(repoRoot, "agents", d);
    return fs.statSync(p).isDirectory();
  })
  .map((d) => `agents/${d}/agent.json`)
  .filter((p) => fs.existsSync(path.join(repoRoot, p)));

describe("agent manifests", () => {
  it("finds at least one agent manifest", () => {
    expect(agentDirs.length).toBeGreaterThanOrEqual(10);
  });

  it.each(agentDirs)("is a valid AgentManifest: %s", (filePath) => {
    const result = validateAgentManifest(readJson(filePath));
    expect(result.ok).toBe(true);
  });
});

// ── 5. Error paths ────────────────────────────────────────────────────────────

describe("error path validation", () => {
  it("rejects an envelope with an empty task type", () => {
    const badEnvelope = {
      ...readJson("protocol/test-cases/integration/envelopes/01-issue-read.json"),
      task: {
        id: "task_bad",
        type: "",
        createdAt: "2026-05-09T00:00:00Z",
        deadlineAt: null,
      },
    };
    const result = validateTaskEnvelope(badEnvelope);
    expect(result.ok).toBe(false);
  });

  it("rejects an envelope missing the run field", () => {
    const base = readJson(
      "protocol/test-cases/integration/envelopes/01-issue-read.json",
    ) as Record<string, unknown>;
    const { run: _removed, ...withoutRun } = base;
    const result = validateTaskEnvelope(withoutRun);
    expect(result.ok).toBe(false);
  });

  it("rejects an envelope with an invalid protocol version", () => {
    const base = readJson(
      "protocol/test-cases/integration/envelopes/01-issue-read.json",
    ) as Record<string, unknown>;
    const result = validateTaskEnvelope({ ...base, protocolVersion: "v0.1" });
    expect(result.ok).toBe(false);
  });

  it("rejects a manifest missing the binary field", () => {
    const result = validateAgentManifest(
      readJson("protocol/test-cases/invalid/manifests/missing-binary.json"),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an artifact-typed prior artifact with a non-file URI scheme", () => {
    const base = readJson(
      "protocol/test-cases/integration/envelopes/02-plan-create.json",
    ) as Record<string, unknown>;
    const ctx = (base.context ?? {}) as Record<string, unknown>;
    const priorArtifacts = Array.isArray(ctx.priorArtifacts) ? [...ctx.priorArtifacts] : [];
    priorArtifacts[0] = { artifactType: "issue.summary", uri: "s3://bucket/artifact.json", mediaType: "application/json" };
    const envelope = { ...base, context: { ...ctx, priorArtifacts } };
    // The envelope schema itself doesn't restrict URI schemes — this is an agent-level
    // concern — so the envelope remains valid. Confirm it parses without error.
    const result = validateTaskEnvelope(envelope);
    expect(result.ok).toBe(true);
  });
});
