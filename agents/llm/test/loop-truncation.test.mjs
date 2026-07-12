// Tests for length-truncation handling in the tool loop. A turn cut off at the
// output-token limit (stopReason "length"/"max_tokens") with no tool calls is
// NOT a finished answer: the loop must prod the model to continue rather than
// return ok:true with a partial result. Returning success there is how a coder
// produced an empty diff reported as "no changes / already implemented"
// (HalleyScore/teramot-aleph run_srv_1783879796612_0, deepseek/deepseek-v4-pro).
// Dependency-free (node:test), run against the built dist with `node --test`.

import assert from "node:assert/strict";
import test from "node:test";
import { runWithTools } from "../dist/index.js";

// A provider whose turns carry an explicit stopReason so truncation can be
// simulated. Each `turns` entry is { content, stopReason }.
function provider(turns) {
  let i = 0;
  return {
    name: "fake",
    model: "fake-1",
    requestTurn: async () => {
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      return {
        ok: true,
        content: turn.content,
        stopReason: turn.stopReason ?? "end_turn",
        inputTokens: 10,
        outputTokens: 5,
      };
    },
  };
}

const editTool = (calls) => [
  {
    name: "edit_file",
    description: "Edit a file.",
    inputSchema: { type: "object" },
    handler: async (input) => {
      calls.push(input);
      return { ok: true, output: "edited" };
    },
  },
];

const base = { system: "test", messages: [{ role: "user", content: "go" }], workspacePath: process.cwd() };

test("length-truncated turn with no tool calls is prodded to continue, then recovers", async () => {
  const calls = [];
  // Turn 1: cut off mid-thought (length), no tool call. Turn 2 (after nudge):
  // the model makes its edit and finishes cleanly.
  const p = provider([
    { content: [{ type: "text", text: "Let me think abou…" }], stopReason: "length" },
    { content: [{ type: "tool_use", id: "e1", name: "edit_file", input: { path: "a.ts" } }], stopReason: "end_turn" },
    { content: [{ type: "text", text: "Done." }], stopReason: "end_turn" },
  ]);

  const result = await runWithTools(p, { ...base, tools: editTool(calls) });

  assert.equal(result.ok, true, "recovers to a successful run after continuing");
  assert.equal(calls.length, 1, "the edit the model was cut off before making now runs");
  const nudge = result.messages.find(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("cut off"),
  );
  assert.ok(nudge, "a continue nudge was appended after truncation");
});

test("a turn that keeps truncating with no progress fails as output_truncated (not a false success)", async () => {
  // Always truncated, never a tool call: must fail explicitly rather than return
  // ok:true with an empty/partial result that reads downstream as "no changes".
  const p = provider([{ content: [{ type: "text", text: "thinking…" }], stopReason: "length" }]);

  const result = await runWithTools(p, { ...base, tools: editTool([]) });

  assert.equal(result.ok, false);
  assert.equal(result.code, "output_truncated");
});

test("truncation counter resets on progress: truncate→act→truncate→act still succeeds", async () => {
  const calls = [];
  // Alternating truncated + acting turns, more than MAX_TRUNCATION_CONTINUES (3)
  // truncations in total but never 4 in a row, so the run is never failed.
  const p = provider([
    { content: [{ type: "text", text: "…" }], stopReason: "length" },
    { content: [{ type: "tool_use", id: "e1", name: "edit_file", input: { path: "a" } }], stopReason: "end_turn" },
    { content: [{ type: "text", text: "…" }], stopReason: "length" },
    { content: [{ type: "tool_use", id: "e2", name: "edit_file", input: { path: "b" } }], stopReason: "end_turn" },
    { content: [{ type: "text", text: "…" }], stopReason: "length" },
    { content: [{ type: "tool_use", id: "e3", name: "edit_file", input: { path: "c" } }], stopReason: "end_turn" },
    { content: [{ type: "text", text: "All done." }], stopReason: "end_turn" },
  ]);

  const result = await runWithTools(p, { ...base, tools: editTool(calls) });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 3, "each acting turn ran its edit; truncations between them did not fail the run");
});

test("a clean end_turn with no tool calls is unaffected (still a terminal success)", async () => {
  const p = provider([{ content: [{ type: "text", text: "final answer" }], stopReason: "end_turn" }]);
  const result = await runWithTools(p, { ...base, tools: editTool([]) });
  assert.equal(result.ok, true);
  assert.equal(result.finalText, "final answer");
});
