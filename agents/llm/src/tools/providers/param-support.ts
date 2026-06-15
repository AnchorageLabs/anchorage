// Shared "does the model accept this parameter" predicates used by every
// provider adapter (one-shot and tool-loop). Rather than track which model
// dropped which parameter (Opus 4.7+ removed temperature/top_p/top_k and
// budget_tokens; OpenAI reasoning models require max_completion_tokens), we
// send the parameter, inspect the provider's error, and retry without it. This
// keeps the adapters model-agnostic: a new model that drops a parameter just
// works as long as its error message is recognizable.

/**
 * True when a provider error indicates the `temperature` (or `top_p`/`top_k`)
 * parameter is not accepted by the target model. Lets a caller retry once
 * without temperature instead of failing.
 */
export function isTemperatureUnsupported(message: string): boolean {
  return (
    /temperature|top_p|top_k/i.test(message) &&
    /(deprecat|unsupported|not\s+support|not\s+allowed|invalid|remove)/i.test(message)
  );
}

/**
 * True when a provider rejects `max_completion_tokens` (an older model that
 * only knows `max_tokens`), so the caller can fall back to `max_tokens`.
 */
export function isMaxCompletionTokensUnsupported(message: string): boolean {
  return (
    /max_completion_tokens/i.test(message) &&
    /(unsupported|unrecogni|unknown|not\s+support|invalid)/i.test(message)
  );
}

/**
 * True when a provider rejects `max_tokens` and names `max_completion_tokens`
 * as the correct field (newer OpenAI reasoning models), so the caller can flip
 * to `max_completion_tokens`.
 */
export function wantsMaxCompletionTokens(message: string): boolean {
  return /max_completion_tokens/i.test(message);
}

/**
 * True when a Bedrock model rejects prompt caching (`cachePoint`) — older or
 * caching-incapable models error on the cache blocks rather than ignoring them.
 * Lets the Bedrock adapter retry once WITHOUT cache points so an unsupported
 * model degrades to a normal (uncached) call instead of failing the turn. The
 * cache win is lossless and additive: on models that support it we keep it; on
 * those that don't we transparently drop it.
 */
export function isPromptCachingUnsupported(message: string): boolean {
  return (
    /cachepoint|cache point|prompt cach/i.test(message) &&
    /(unsupported|not\s+support|not\s+allowed|invalid|unknown|does\s+not)/i.test(message)
  );
}
