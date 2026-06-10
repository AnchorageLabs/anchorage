// Tests for terminal-tool mode: a designated tool call ends the loop and its
// input is returned verbatim as finalToolInput (never dispatched to a handler).
// A model that finishes with plain text gets exactly one nudge before the run
// fails with terminal_tool_not_called. Dependency-free (node:test), run against
// the built dist with `node --test`.

import assert from "node:assert/strict";
import test from "node:test";
import { runWithTools } from "../dist/index.js";

function scriptedProvider(turns) {
  let i = 0;
  return {
    name: "fake",
    model: "fake-1",
    requestTurn: async () => {
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      return { ok: true, content: turn, stopReason: "end_turn", inputTokens: 10, outputTokens: 5 };
    },
  };
}

function makeTools(onHandlerCall) {
  return [
    {
      name: "lookup",
      description: "A regular tool.",
      inputSchema: { type: "object" },
      handler: async (input) => {
        onHandlerCall?.("lookup", input);
        return { ok: true, output: "lookup-result" };
      },
    },
    {
      name: "submit_answer",
      description: "Submit the final answer.",
      inputSchema: { type: "object" },
      handler: async (input) => {
        onHandlerCall?.("submit_answer", input);
        return { ok: true, output: "should never run" };
      },
    },
  ];
}

const baseRequest = {
  system: "test",
  messages: [{ role: "user", content: "go" }],
  workspacePath: process.cwd(),
  terminalTool: "submit_answer",
};

test("terminal tool call ends the loop and returns its input verbatim", async () => {
  const handlerCalls = [];
  const events = [];
  const answer = { verdict: "ready", score: 0.9 };
  const provider = scriptedProvider([
    [{ type: "tool_use", id: "t1", name: "submit_answer", input: answer }],
  ]);

  const result = await runWithTools(provider, {
    ...baseRequest,
    tools: makeTools((name, input) => handlerCalls.push({ name, input })),
    onEvent: (e) => events.push(e),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.finalToolInput, answer);
  assert.equal(handlerCalls.length, 0, "terminal tool handler must not be dispatched");
  assert.deepEqual(
    events.map((e) => e.kind),
    ["tool.requested", "tool.result"],
    "terminal call still emits the audit event pair",
  );
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "submit_answer");
});

test("plain-text finish gets one nudge, then succeeds when the model complies", async () => {
  const answer = { verdict: "ok" };
  const provider = scriptedProvider([
    [{ type: "text", text: "Here is my answer in prose." }],
    [{ type: "tool_use", id: "t1", name: "submit_answer", input: answer }],
  ]);

  const result = await runWithTools(provider, { ...baseRequest, tools: makeTools() });

  assert.equal(result.ok, true);
  assert.deepEqual(result.finalToolInput, answer);
  const nudge = result.messages.find(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("submit_answer"),
  );
  assert.ok(nudge, "nudge message should be in the transcript");
});

test("plain-text finish twice fails with terminal_tool_not_called", async () => {
  const provider = scriptedProvider([
    [{ type: "text", text: "prose one" }],
    [{ type: "text", text: "prose two" }],
  ]);

  const result = await runWithTools(provider, { ...baseRequest, tools: makeTools() });

  assert.equal(result.ok, false);
  assert.equal(result.code, "terminal_tool_not_called");
});

test("regular tools bundled with the terminal call are not executed", async () => {
  const handlerCalls = [];
  const provider = scriptedProvider([
    [
      { type: "tool_use", id: "t1", name: "lookup", input: { q: "x" } },
      { type: "tool_use", id: "t2", name: "submit_answer", input: { verdict: "done" } },
    ],
  ]);

  const result = await runWithTools(provider, {
    ...baseRequest,
    tools: makeTools((name, input) => handlerCalls.push({ name, input })),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.finalToolInput, { verdict: "done" });
  assert.equal(handlerCalls.length, 0);
});

test("without terminalTool, text finish still returns finalText (no behaviour change)", async () => {
  const provider = scriptedProvider([[{ type: "text", text: "plain answer" }]]);
  const { terminalTool: _omit, ...request } = baseRequest;

  const result = await runWithTools(provider, { ...request, tools: makeTools() });

  assert.equal(result.ok, true);
  assert.equal(result.finalText, "plain answer");
  assert.equal(result.finalToolInput, undefined);
});

test("regular tool loop still dispatches handlers before the terminal call", async () => {
  const handlerCalls = [];
  const provider = scriptedProvider([
    [{ type: "tool_use", id: "t1", name: "lookup", input: { q: "first" } }],
    [{ type: "tool_use", id: "t2", name: "submit_answer", input: { verdict: "after-lookup" } }],
  ]);

  const result = await runWithTools(provider, {
    ...baseRequest,
    tools: makeTools((name, input) => handlerCalls.push({ name, input })),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(handlerCalls, [{ name: "lookup", input: { q: "first" } }]);
  assert.deepEqual(result.finalToolInput, { verdict: "after-lookup" });
});
