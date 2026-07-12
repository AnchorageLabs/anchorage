// Tests for the terminal refusal guard: tool calls refused BY THE LOOP
// (repeat_backstop / duplicate-grep enforce / unknown tool) cost a full LLM
// round-trip each, so a model that racks up consecutive refusals with zero
// dispatched calls between them is divergent — the loop must fail honestly
// instead of letting it spiral (field case: 370 refused greps in one run).
// Dependency-free (node:test), run against the built dist.

import assert from "node:assert/strict";
import test from "node:test";
import { runWithTools } from "../dist/index.js";

// Provider that scripts one tool_use per turn, cycling through `calls`; after
// they run out it keeps repeating the last one.
function providerOf(calls) {
  let i = 0;
  return {
    name: "fake",
    model: "fake-1",
    requestTurn: async () => {
      const call = calls[Math.min(i, calls.length - 1)];
      i += 1;
      return {
        ok: true,
        content: [{ type: "tool_use", id: `t${i}`, name: call.name, input: call.input ?? {} }],
        stopReason: "tool_use",
        inputTokens: 10,
        outputTokens: 5,
      };
    },
  };
}

const echoTool = {
  name: "echo",
  description: "echo",
  inputSchema: { type: "object" },
  handler: async (input) => ({ ok: true, output: `echo:${JSON.stringify(input)}` }),
};

const base = {
  system: "t",
  messages: [{ role: "user", content: "go" }],
  workspacePath: process.cwd(),
};

test("12 consecutive unknown-tool refusals fail the run as model_loop_divergent", async () => {
  const p = providerOf([{ name: "no_such_tool" }]); // repeats forever
  const result = await runWithTools(p, { ...base, tools: [echoTool] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "model_loop_divergent");
  // Exactly at the limit — not hundreds of wasted round-trips.
  const refused = result.toolCalls.filter((c) => !c.ok).length;
  assert.equal(refused, 12);
});

test("a dispatched call between refusals resets the counter (no false trip)", async () => {
  // 8 refusals, one real call, 8 more refusals, then a clean text finish.
  const calls = [
    ...Array(8).fill({ name: "no_such_tool" }),
    { name: "echo", input: { n: 1 } },
    ...Array(8).fill({ name: "no_such_tool" }),
  ];
  let i = 0;
  const p = {
    name: "fake",
    model: "fake-1",
    requestTurn: async () => {
      const call = calls[i];
      i += 1;
      if (!call) {
        return {
          ok: true,
          content: [{ type: "text", text: "done" }],
          stopReason: "end_turn",
          inputTokens: 1,
          outputTokens: 1,
        };
      }
      return {
        ok: true,
        content: [{ type: "tool_use", id: `t${i}`, name: call.name, input: call.input ?? {} }],
        stopReason: "tool_use",
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
  const result = await runWithTools(p, { ...base, tools: [echoTool] });
  assert.equal(result.ok, true, "8+8 refusals with a real call between them never trips the guard");
  assert.equal(result.finalText, "done");
});

test("repeat_backstop refusals count toward the terminal limit", async () => {
  // The same (tool, input) with identical output: 3 identical runs arm the
  // backstop, then every repeat is refused. The refusals must eventually
  // terminate the run instead of spinning forever.
  const p = providerOf([{ name: "echo", input: { same: true } }]);
  const result = await runWithTools(p, { ...base, tools: [echoTool] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "model_loop_divergent");
  const refused = result.toolCalls.filter((c) => !c.ok).length;
  assert.equal(refused, 12, "stopped at the refusal limit, not the (infinite) turn budget");
});
