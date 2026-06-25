import type { CliConfig } from "./config.js";

// Light structural types — the CLI prints JSON/summary lines, so it only needs
// the fields it reads. Kept local (no SDK dep) so the CLI stays a thin REST shim.
export interface RunSummary {
  id: string;
  owner: string;
  repo: string;
  workflow: string;
  status: string;
  issue?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  currentStep?: string | null;
  awaitingApproval?: boolean;
  [key: string]: unknown;
}

export interface WorkflowInfo {
  name: string;
  steps: string[];
}

export interface RepoIssue {
  number: number;
  title: string;
}

export interface ConnectorStatus {
  available: boolean;
  connected?: boolean;
  login?: string;
  error?: string;
  source?: "oauth" | "env";
  kind?: string;
}

export interface SourceSummary {
  id: string;
  label: string;
  workflow: string;
  refField: string;
  connector: string;
  prTarget: string;
  connected: boolean;
  prReady: boolean;
  connectUrl?: string;
}

export interface LlmStatus {
  provider?: string;
  model?: string;
  baseUrl?: string;
  hasKey: boolean;
}

export interface MeProfile {
  kind: "admin" | "client";
  id?: string;
  name?: string;
  repoAllowlist?: string[];
  llm?: LlmStatus | null;
}

interface PatchMeResponse {
  ok: true;
  client: { llm?: LlmStatus | null };
}

export interface RunDiff {
  branch?: string;
  base?: string;
  diff?: string;
  [key: string]: unknown;
}

export interface TriggerParams {
  owner: string;
  repo: string;
  branch?: string;
  issue?: number;
  instruction?: string;
  prNumber?: number;
  notionPage?: string;
  jiraIssue?: string;
  linearIssue?: string;
  gitlabIssue?: string;
  bitbucketIssue?: string;
  pipeline?: string;
  llmProvider?: string;
  llmModel?: string;
}

export interface ProtocolEvent {
  type: string;
  message: string;
  [key: string]: unknown;
}

/**
 * HTTP client for the orchestrator REST API. The CLI talks cross-origin from a
 * terminal, so it sends the secret explicitly on every request (Bearer +
 * X-Orchestrator-Secret — the server accepts either).
 */
export class OrchestratorClient {
  constructor(private readonly cfg: CliConfig) {}

  get serverUrl(): string {
    return this.cfg.serverUrl;
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["Content-Type"] = "application/json";
    if (this.cfg.secret) {
      h.Authorization = `Bearer ${this.cfg.secret}`;
      h["X-Orchestrator-Secret"] = this.cfg.secret;
    }
    return h;
  }

  private async request<T>(pathname: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.serverUrl}${pathname}`, init);
    } catch (err) {
      const cause = err instanceof Error ? (err.cause ?? err) : err;
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`could not reach the orchestrator at ${this.cfg.serverUrl}: ${detail}`);
    }
    if (!res.ok) {
      let message = `${init?.method ?? "GET"} ${pathname}: ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) message = body.error;
      } catch {
        // non-JSON body — keep the status message
      }
      throw new Error(message);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  private get<T>(pathname: string): Promise<T> {
    return this.request<T>(pathname, { headers: this.headers(false) });
  }

  private send<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    return this.request<T>(pathname, {
      method,
      headers: this.headers(body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  whoami(): Promise<{ kind: string; clientId?: string; name?: string }> {
    return this.get("/auth/whoami");
  }

  listRuns(): Promise<RunSummary[]> {
    return this.get("/runs");
  }

  getRun(runId: string): Promise<RunSummary> {
    return this.get(`/runs/${encodeURIComponent(runId)}`);
  }

  listWorkflows(): Promise<WorkflowInfo[]> {
    return this.get("/workflows");
  }

  listRepos(): Promise<string[]> {
    return this.get("/repos");
  }

  listIssues(ownerRepo: string): Promise<RepoIssue[]> {
    return this.get(`/repos/${ownerRepo}/issues`);
  }

  triggerRun(params: TriggerParams): Promise<RunSummary> {
    return this.send("POST", "/runs", params);
  }

  decideRun(runId: string, approved: boolean): Promise<void> {
    return this.send(
      "POST",
      `/runs/${encodeURIComponent(runId)}/${approved ? "approve" : "reject"}`,
      {
        by: "cli",
      },
    );
  }

  cancelRun(runId: string): Promise<void> {
    return this.send("POST", `/runs/${encodeURIComponent(runId)}/cancel`, { by: "cli" });
  }

  /** Resume a FAILED run from its salvage branch. Returns the new run. With an
   *  instruction the work is redirected; without, the original task continues. */
  resumeRun(runId: string, instruction?: string): Promise<RunSummary> {
    return this.send(
      "POST",
      `/runs/${encodeURIComponent(runId)}/resume`,
      instruction ? { instruction } : {},
    );
  }

  getRunDiff(runId: string): Promise<RunDiff> {
    return this.get(`/runs/${encodeURIComponent(runId)}/diff`);
  }

  getRunArtifacts(runId: string): Promise<unknown> {
    return this.get(`/runs/${encodeURIComponent(runId)}/artifacts`);
  }

  getRunManifest(runId: string): Promise<unknown> {
    return this.get(`/runs/${encodeURIComponent(runId)}/manifest`);
  }

  /** Record the human verdict on a finished run: 👍 ("ok"), 👎 ("not_ok",
   *  optionally with a message that can start a correction run), or "clear". */
  setOutcome(runId: string, outcome: string, message?: string): Promise<unknown> {
    return this.send("POST", `/runs/${encodeURIComponent(runId)}/outcome`, {
      outcome,
      ...(message ? { message } : {}),
    });
  }

  /** Rotate (issue) the caller's own API token. Returned once; invalidates the
   *  previous token. */
  rotateToken(): Promise<{ token: string }> {
    return this.send("POST", "/me/token");
  }

  getConnectors(): Promise<Record<string, ConnectorStatus>> {
    return this.get("/connectors");
  }

  getSources(connectedOnly = false): Promise<{ sources: SourceSummary[] }> {
    return this.get(`/sources${connectedOnly ? "?connected=1" : ""}`);
  }

  startConnect(
    provider: string,
  ): Promise<{ provider: string; authorizeUrl: string; kind: string }> {
    return this.get(`/oauth/${encodeURIComponent(provider)}/start`);
  }

  disconnect(provider: string): Promise<{ provider: string; removed: number }> {
    return this.send("DELETE", `/connectors/${encodeURIComponent(provider)}`);
  }

  getMe(): Promise<MeProfile> {
    return this.get("/me");
  }

  setModel(provider: string, model: string, apiKey?: string): Promise<LlmStatus | null> {
    return this.send<PatchMeResponse>("PATCH", "/me", {
      llm: { provider, model, ...(apiKey ? { apiKey } : {}) },
    }).then((r) => r.client.llm ?? null);
  }

  /**
   * Stream NDJSON run events to `onEvent` until the run ends (stream close),
   * `idleMs` elapse with no bytes, or `signal` aborts. Used by `runs watch`.
   */
  async streamEvents(
    runId: string,
    onEvent: (event: ProtocolEvent) => void,
    opts: { idleMs?: number } = {},
  ): Promise<void> {
    const { idleMs = 600_000 } = opts;
    const controller = new AbortController();
    let idle = setTimeout(() => controller.abort(), idleMs);
    try {
      const res = await fetch(`${this.cfg.serverUrl}/runs/${encodeURIComponent(runId)}/events`, {
        headers: this.headers(false),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        clearTimeout(idle);
        idle = setTimeout(() => controller.abort(), idleMs);
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            onEvent(JSON.parse(line) as ProtocolEvent);
          } catch {
            // skip unparseable lines
          }
        }
      }
    } catch {
      // aborted / connection dropped — caller treats this as end-of-stream
    } finally {
      clearTimeout(idle);
    }
  }
}
