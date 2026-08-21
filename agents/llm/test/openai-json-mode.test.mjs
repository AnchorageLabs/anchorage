// Tests for opt-in JSON mode (response_format: json_object) on the
// OpenAI-compatible provider: sent when requested, omitted by default, and
// flexed off with a retry when the API rejects the parameter — the same
// degrade-don't-fail pattern as the token-budget parameters.
// Run against the built dist with `node --test`.

import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAiProvider } from "../dist/index.js";

// Swap global.fetch for canned responses; capture the request bodies sent.
// `responder` receives the call index and returns the Response for that call.
function mockFetchSequence(responder) {
  const calls = [];
  global.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return responder(calls.length - 1);
  };
  return calls;
}

const okResponse = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const turnInput = {
  system: "You are a careful coding agent.",
  messages: [{ role: "user", content: "reply with the plan JSON" }],
  tools: [],
  maxTokens: 100,
};

test("omits response_format by default", async () => {
  const calls = mockFetchSequence(okResponse);
  const provider = createOpenAiProvider({ apiKey: "k", model: "gpt-4.1" });
  const result = await provider.requestTurn(turnInput);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].response_format, undefined);
});

test("sends response_format json_object when requested", async () => {
  const calls = mockFetchSequence(okResponse);
  const provider = createOpenAiProvider({ apiKey: "k", model: "gpt-4.1" });
  const result = await provider.requestTurn({ ...turnInput, responseFormat: "json_object" });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].response_format, { type: "json_object" });
});

test("drops response_format and retries when the API rejects it", async () => {
  const calls = mockFetchSequence((i) =>
    i === 0
      ? new Response(
          JSON.stringify({
            error: { message: "response_format is not supported by this model" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        )
      : okResponse(),
  );
  const provider = createOpenAiProvider({
    apiKey: "k",
    model: "deepseek/deepseek-v4-flash",
    baseUrl: "https://openrouter.ai/api/v1",
  });
  const result = await provider.requestTurn({ ...turnInput, responseFormat: "json_object" });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].response_format, { type: "json_object" });
  assert.equal(calls[1].response_format, undefined);
});
