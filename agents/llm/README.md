# @anchorage/agent-llm

Shared LLM provider adapter for Anchorage reference agents.

Three providers are supported. Each works on both paths — the one-shot
`requestLlmCompletion` and the multi-turn tool loop (`runWithTools` via
`providerFromLlmConfig`):

- `anthropic`: Anthropic Messages API via `ANTHROPIC_API_KEY` (optional `ANTHROPIC_BASE_URL`).
- `openai`: OpenAI Chat Completions via `OPENAI_API_KEY` (optional `OPENAI_BASE_URL`).
- `bedrock` (alias `aws-bedrock`): AWS Bedrock Converse via the standard AWS credential chain
  (`AWS_BEARER_TOKEN_BEDROCK`, access keys, profile, or role) and `AWS_REGION`.

## Switching providers and models

Set `ANCHORAGE_LLM_PROVIDER` to `anthropic`, `openai`, or `bedrock`. If it is
omitted, the provider is inferred from available credentials in this order:
`ANTHROPIC_API_KEY` → Anthropic, `OPENAI_API_KEY` → OpenAI, then AWS Bedrock
credentials.

Pick the model with (highest precedence first):

1. `ANCHORAGE_<ROLE>_MODEL` — per-agent override (e.g. `ANCHORAGE_CODER_MODEL`).
2. `ANCHORAGE_LLM_MODEL` — applies to every role.
3. The role's built-in default for the active provider.

Two example profiles — only the env differs, no code change:

```bash
# Cheap testing profile
ANCHORAGE_LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANCHORAGE_LLM_MODEL=claude-haiku-4-5

# Quality production profile
ANCHORAGE_LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANCHORAGE_LLM_MODEL=claude-opus-4-8
```

## Model-parameter compatibility

Both the one-shot path and the tool-loop provider adapters flex parameters on
the provider's error rather than tracking model names, so newer models that
drop parameters keep working:

- `temperature` / `top_p` / `top_k` — retried without the parameter when the
  model rejects it (e.g. Anthropic Opus 4.7+ removed them).
- OpenAI token budget — starts as `max_completion_tokens` (reasoning models)
  and falls back to `max_tokens` for older models, or vice versa.
- Bedrock Converse drives the tool loop natively via `toolConfig`, with the
  same `temperature` retry.

Set `ANCHORAGE_LLM_PROMPT_CACHE=false` to disable Anthropic prompt caching.
