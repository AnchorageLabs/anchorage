// Tests for OpenAI-compatible prompt caching parity: the provider must route a
// run's turns to one cache via a stable prompt_cache_key, honour the opt-out,
// and read cache-hit tokens from both the OpenAI and DeepSeek usage shapes.
// Run against the built dist with `node --test`.

import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAiProvider } from "../dist/index.js";

// Swap global.fetch for one canned response; capture the request body sent.
function mockFetch(usage) {
  const calls = [];
  global.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return calls;
}

const turnInput = {
  system: "You are a careful coding agent.",
  messages: [{ role: "user", content: "hi" }],
  tools: [{ name: "read_file", description: "read", inputSchema: { type: "object" } }],
  maxTokens: 100,
};

test("sends a stable prompt_cache_key derived from the prefix", async () => {
  const calls = mockFetch({ prompt_tokens: 50, completion_tokens: 5 });
  const provider = createOpenAiProvider({ apiKey: "k", model: "gpt-4.1" });
  await provider.requestTurn(turnInput);
  await provider.requestTurn(turnInput);
  assert.equal(calls.length, 2);
  assert.match(calls[0].prompt_cache_key, /^anchorage-[0-9a-f]{32}$/);
  // Same prefix → same key across turns, so OpenAI routes them to one cache.
  assert.equal(calls[0].prompt_cache_key, calls[1].prompt_cache_key);
});

test("omits prompt_cache_key when caching is disabled", async () => {
  const calls = mockFetch({ prompt_tokens: 50, completion_tokens: 5 });
  const provider = createOpenAiProvider({ apiKey: "k", model: "gpt-4.1", promptCache: false });
  await provider.requestTurn(turnInput);
  assert.equal(calls[0].prompt_cache_key, undefined);
});

test("reads cache hits from the OpenAI usage shape", async () => {
  mockFetch({
    prompt_tokens: 50,
    completion_tokens: 5,
    prompt_tokens_details: { cached_tokens: 40 },
  });
  const provider = createOpenAiProvider({ apiKey: "k", model: "gpt-4.1" });
  const result = await provider.requestTurn(turnInput);
  assert.equal(result.ok, true);
  assert.equal(result.cacheReadInputTokens, 40);
});

test("reads cache hits from the DeepSeek usage shape", async () => {
  mockFetch({ prompt_tokens: 50, completion_tokens: 5, prompt_cache_hit_tokens: 33 });
  const provider = createOpenAiProvider({ apiKey: "k", model: "deepseek-chat" });
  const result = await provider.requestTurn(turnInput);
  assert.equal(result.cacheReadInputTokens, 33);
});
