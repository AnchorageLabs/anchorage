#!/usr/bin/env node
// Smoke-test the tool loop against a fake provider. Verifies:
//   - registry filtering by capability
//   - tool dispatch with sandbox + budget
//   - event emission
//   - terminal-turn detection and message accumulation
//
// Run: node agents/llm/scripts/smoke-tool-loop.mjs

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { repoReadTools, runWithTools } from "../dist/index.js";

const workspacePath = mkdtempSync(path.join(tmpdir(), "anchorage-smoke-"));
writeFileSync(path.join(workspacePath, "hello.txt"), "world\n");
writeFileSync(path.join(workspacePath, "secret.txt"), "should-not-be-read\n");

let turn = 0;
const fakeProvider = {
  name: "fake",
  model: "fake-1",
  async requestTurn({ tools, messages }) {
    turn += 1;
    if (turn === 1) {
      // Sanity: capability filtering should keep the repo-read tools because
      // we granted repo.read. write_file (workspace.write) must be absent.
      const names = tools.map((t) => t.name).sort();
      if (!names.includes("read_file") || !names.includes("grep")) {
        throw new Error(`expected read_file + grep in tools, got ${names.join(",")}`);
      }
      if (names.includes("write_file")) {
        throw new Error(`write_file leaked into catalog despite missing capability`);
      }
      return {
        ok: true,
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "read_file",
            input: { path: "hello.txt" },
          },
        ],
        stopReason: "tool_use",
        inputTokens: 100,
        outputTokens: 30,
      };
    }
    // Verify the previous user turn carried a tool_result with the file content.
    const lastUser = messages[messages.length - 1];
    const block = Array.isArray(lastUser.content)
      ? lastUser.content.find((b) => b.type === "tool_result")
      : null;
    if (!block) throw new Error("missing tool_result block on turn 2");
    const text = typeof block.content === "string" ? block.content : "";
    if (!text.includes("world")) {
      throw new Error(`tool_result did not contain file content; got: ${text.slice(0, 80)}`);
    }
    return {
      ok: true,
      content: [{ type: "text", text: "done. saw world." }],
      stopReason: "end_turn",
      inputTokens: 120,
      outputTokens: 10,
    };
  },
};

const events = [];
const result = await runWithTools(fakeProvider, {
  system: "smoke test",
  messages: [{ role: "user", content: "test" }],
  tools: repoReadTools, // includes write tools? no — repoReadTools is read-only
  workspacePath,
  capabilities: ["repo.read"],
  env: {},
  onEvent: (ev) => events.push(ev),
});

if (!result.ok) {
  console.error("FAIL: loop returned !ok", result);
  process.exit(1);
}

const summary = {
  finalText: result.finalText,
  stopReason: result.stopReason,
  toolCallsLen: result.toolCalls.length,
  snapshot: result.snapshot,
  eventCount: events.length,
  eventKinds: events.map((e) => e.kind),
};

// Assertions
const checks = [
  ["finalText matches", result.finalText === "done. saw world."],
  ["one tool call", result.toolCalls.length === 1],
  ["tool call ok", result.toolCalls[0]?.ok === true],
  ["snapshot.toolTurns=2", result.snapshot.toolTurns === 2],
  ["snapshot.filesRead has hello.txt", result.snapshot.filesRead.includes("hello.txt")],
  ["snapshot.filesRead omits secret.txt", !result.snapshot.filesRead.includes("secret.txt")],
  ["two events emitted", events.length === 2],
  [
    "events: requested then result",
    events[0]?.kind === "tool.requested" && events[1]?.kind === "tool.result",
  ],
  ["event.result.success", events[1]?.success === true],
];

let allPass = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) allPass = false;
}
console.log("");
console.log("summary:", JSON.stringify(summary, null, 2));

process.exit(allPass ? 0 : 1);
