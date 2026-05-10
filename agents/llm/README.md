# @anchorage/agent-llm

Shared LLM provider adapter for Anchorage reference agents.

Supported providers:

- `anthropic`: Anthropic Messages API via `ANTHROPIC_API_KEY`.
- `openai`: OpenAI-compatible Chat Completions via `OPENAI_API_KEY`.
- `openai-compatible`: any Chat Completions-compatible endpoint via `ANCHORAGE_LLM_BASE_URL` and `ANCHORAGE_LLM_API_KEY`.
- `moonshot` / `kimi`: Moonshot/Kimi Chat Completions-compatible endpoint via `MOONSHOT_API_KEY` or `KIMI_API_KEY`.
- `bedrock` / `aws-bedrock`: AWS Bedrock Converse via standard AWS credentials.

Set `ANCHORAGE_LLM_PROVIDER` for explicit provider selection. If it is omitted, agents infer a provider from available credentials in this order: Anthropic, OpenAI, Moonshot/Kimi, OpenAI-compatible with `ANCHORAGE_LLM_BASE_URL`, then Bedrock.
