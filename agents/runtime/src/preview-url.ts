/**
 * Resolve the preview URL the runtime agent REPORTS to the orchestrator
 * (runtime-preview artifact payloads, protocol events, startStrategy results).
 *
 * When the agent runs inside a container or behind a tunnel/proxy, the URL it
 * can reach the preview at (http://localhost:<port>) is not the URL a human
 * can open. Operators set ANCHORAGE_PREVIEW_PUBLIC_URL to the externally
 * reachable address, and we report that instead.
 *
 * Internal consumers (readiness probing, port freeing) must keep using the
 * localhost URL — this helper is only for values that leave the agent.
 */
export function publicPreviewUrl(localUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.ANCHORAGE_PREVIEW_PUBLIC_URL?.trim() || localUrl;
}
