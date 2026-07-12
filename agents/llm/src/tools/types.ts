// Public tool-loop types. The agents author tools, configure a budget, and
// call runWithTools(); this module describes the contract that connects them.
//
// Internal message shape mirrors Anthropic's content-block model (text +
// tool_use + tool_result). The OpenAI provider adapter translates to/from this
// shape so callers never see provider-specific message structures.

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonObject | JsonValue[] | boolean | null | number | string;

// ── Content blocks ──────────────────────────────────────────────────────────

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: JsonObject;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  // String or pre-formatted blocks; stringified for OpenAI, kept as blocks for
  // Anthropic. Most tool outputs are strings; image/structured blocks reserved.
  content: string | ContentBlock[];
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface UserMessage {
  role: "user";
  content: string | ContentBlock[];
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
}

export type LoopMessage = UserMessage | AssistantMessage;

// ── Tool definition + handler ───────────────────────────────────────────────

/**
 * A tool the model can invoke. `inputSchema` is a JSON Schema object passed to
 * the provider verbatim — the provider uses it to constrain tool_use inputs
 * the model emits. The runtime does not validate inputs against this schema;
 * handlers should validate defensively.
 *
 * `capability` (optional) gates the tool against the run's
 * `task.capabilities[]`. When set, runWithTools drops the tool from the
 * catalog the model sees unless the capability is present.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
  capability?: string;
  handler: ToolHandler;
}

export type ToolHandler = (input: JsonObject, ctx: ToolContext) => Promise<ToolHandlerResult>;

/**
 * Tool handlers return structured results. `ok: false` is reported to the
 * model as a tool_result with is_error=true; the loop continues so the model
 * can react. `ok: true` content is delivered verbatim. `bytesOut` (optional)
 * is counted against budgets when the runtime can't measure it itself.
 */
export type ToolHandlerResult =
  | {
      ok: true;
      output: string | ContentBlock[];
      bytesOut?: number;
      meta?: JsonObject;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

// ── Tool execution context ──────────────────────────────────────────────────

/**
 * A read-only repository mounted for cross-repo reads. Addressed by `ref`
 * ("owner/name") via the optional `repo` argument on the read tools; reads
 * resolve under `root`, which is cloned read-only so it can never be written.
 */
export interface ContextRepoMount {
  ref: string;
  root: string;
  note?: string;
}

// A prior-step artifact the agent may pull on demand via get_artifact. Mirrors
// the orchestrator's ArtifactReference (the fields the tool needs), so an agent
// can fetch an artifact's full content without inlining it into the prompt.
export interface ToolArtifactRef {
  artifactType: string;
  uri: string;
  sizeBytes?: number;
}

export interface ToolContext {
  // Workspace root for the run. Repo-read / shell tools sandbox here.
  workspacePath: string;
  // Prior-step artifacts addressable by get_artifact (the run's priorArtifacts).
  // Empty/undefined when the caller passes none.
  artifacts?: readonly ToolArtifactRef[];
  // Read-only context repos for this run, addressable via the read tools' `repo`
  // argument. Empty/undefined for single-repo runs.
  contextRepos?: ContextRepoMount[];
  // Capability set granted by the run envelope; used by handlers for
  // secondary checks (the runtime already filtered the catalog by capability).
  capabilities: ReadonlySet<string>;
  // Effective environment a tool may read (already scrubbed of secrets that
  // shouldn't leak into shell commands).
  env: Record<string, string>;
  // Live budget state. Handlers update this for resources the runtime can't
  // observe (e.g. unique files read).
  budget: BudgetState;
  // Emit a structured tool event for audit / observability. The runtime calls
  // this around every dispatch; handlers may emit additional intermediate
  // events for long-running tools.
  emit: ToolEventEmitter;
  // Convenience logger for tool-internal debug messages (non-protocol).
  log: (message: string) => void;
}

// ── Budgets ─────────────────────────────────────────────────────────────────

export interface BudgetConfig {
  maxTurns: number;
  maxInputTokens: number;
  maxFiles: number;
  maxWebCalls: number;
  maxShellCalls: number;
  // Wall-clock cap (ms) for the whole tool loop. The last-resort backstop against
  // a run that makes no progress yet never errors (e.g. a provider that keeps
  // answering slowly). Infinity = uncapped (default); set per run or via env.
  maxWallClockMs: number;
  webEnabled: boolean;
}

export interface BudgetState extends BudgetConfig {
  // Absolute time (ms epoch) the loop must finish by; Infinity when uncapped.
  deadlineMs: number;
  turns: number;
  inputTokensTotal: number;
  outputTokensTotal: number;
  cacheReadInputTokensTotal: number;
  cacheCreationInputTokensTotal: number;
  filesRead: Set<string>;
  webCalls: number;
  shellCalls: number;
  bytesAcquired: number;
}

export type BudgetExceededReason =
  | "max_turns"
  | "max_input_tokens"
  | "max_files"
  | "max_web_calls"
  | "max_shell_calls"
  | "max_wall_clock"
  | "web_disabled";

// ── Events ──────────────────────────────────────────────────────────────────

export interface ToolEventRequested {
  kind: "tool.requested";
  tool: string;
  input: JsonObject;
  turn: number;
}

export interface ToolEventResult {
  kind: "tool.result";
  tool: string;
  success: boolean;
  durationMs: number;
  output: JsonObject;
  turn: number;
}

export type ToolEvent = ToolEventRequested | ToolEventResult;
export type ToolEventEmitter = (event: ToolEvent) => void;

// ── Loop request + result ───────────────────────────────────────────────────

export interface RunWithToolsRequest {
  system: string;
  messages: LoopMessage[];
  tools: ToolDefinition[];
  budget?: Partial<BudgetConfig>;
  maxTokensPerTurn?: number;
  temperature?: number;
  // Forwarded to the ToolContext. The runtime owns workspacePath/budget/emit;
  // callers provide capabilities + env.
  capabilities?: Iterable<string>;
  env?: Record<string, string>;
  workspacePath: string;
  // Read-only context repos forwarded to the ToolContext (optional).
  contextRepos?: ContextRepoMount[];
  // Prior-step artifacts the agent may pull via get_artifact (optional).
  artifacts?: readonly ToolArtifactRef[];
  // Observer for structured tool events; mirrors the protocol's tool.requested
  // / tool.result emission shape so callers can pipe directly to stdout.
  onEvent?: ToolEventEmitter;
  // Name of the tool whose invocation ends the loop. The call is not dispatched
  // to a handler: its input is returned verbatim as `finalToolInput`. This lets
  // agents receive their final answer as provider-validated structured JSON
  // instead of parsing free text. The named tool must still be present in
  // `tools` so the model sees its schema.
  terminalTool?: string;
}

export interface ContextSnapshot {
  bytesAcquired: number;
  filesRead: string[];
  toolTurns: number;
  webCalls: number;
  shellCalls: number;
  inputTokensTotal: number;
  outputTokensTotal: number;
  // Prompt-cache token totals across the run (0 when the provider doesn't
  // report cache usage). cacheRead is billed ~10% of input and cacheCreation
  // ~125%; together with inputTokensTotal (the uncached remainder) they give the
  // full input picture needed to compute real $ savings from caching.
  cacheReadInputTokensTotal: number;
  cacheCreationInputTokensTotal: number;
  // ── Context-miss signals ──────────────────────────────────────────────────
  // Heuristics that hint the run was under-served by the lexical tool surface
  // (grep / read_file) and might benefit from symbol-level lookup. Emitted on
  // the `context.snapshot` event so we can measure, across real runs, how often
  // agents hit these before committing to a symbol tool. Instrumentation only —
  // nothing in the loop changes behaviour based on them.
  //
  // True when the run reached its unique-file cap (ANCHORAGE_TOOL_MAX_FILES);
  // always false when the cap is unlimited.
  filesReadCapHit: boolean;
  // Number of `grep` calls that repeated a pattern already searched this run
  // (total grep calls minus distinct patterns) — a proxy for blindly hunting a
  // symbol the model couldn't resolve.
  repeatedSymbolGrep: number;
  // Count of `grep`→`read_file` adjacencies — a proxy for manual cross-file
  // chasing that a references lookup would short-circuit.
  grepReadChurn: number;
  // Context-miss nudges that actually fired during the run (one entry per
  // distinct signal: "repeated_grep" | "grep_read_churn" | "files_read_cap").
  // Unlike the counts above — which are pure end-of-run instrumentation — these
  // reflect the in-loop guidance the model was given to steer it off churn.
  // Empty when nothing fired or nudging is disabled (ANCHORAGE_TOOL_CONTEXT_NUDGE=false).
  contextNudges: string[];
}

export interface ToolCallRecord {
  name: string;
  input: JsonObject;
  ok: boolean;
  durationMs: number;
  turn: number;
}

export type RunWithToolsResult =
  | {
      ok: true;
      finalText: string;
      // Present iff the run ended via `terminalTool`: the verbatim input of that
      // call. Callers should validate it defensively — provider-side schema
      // enforcement is strong but not contractual on every provider.
      finalToolInput?: JsonObject;
      stopReason: string | null;
      messages: LoopMessage[];
      toolCalls: ToolCallRecord[];
      snapshot: ContextSnapshot;
    }
  | {
      ok: false;
      code:
        | "budget_exceeded"
        | "provider_error"
        | "invalid_tool_call"
        | "model_loop_divergent"
        | "output_truncated"
        | "terminal_tool_not_called";
      message: string;
      reason?: BudgetExceededReason;
      messages: LoopMessage[];
      toolCalls: ToolCallRecord[];
      snapshot: ContextSnapshot;
    };

// ── Provider adapter ────────────────────────────────────────────────────────

/**
 * One provider call: messages + tool catalog → assistant content blocks. The
 * adapter handles native tool-schema translation and stop-reason mapping. The
 * loop is provider-agnostic; only the adapter knows about Anthropic vs OpenAI.
 */
export interface ProviderAdapter {
  readonly name: string;
  readonly model: string;
  requestTurn(input: ProviderTurnInput): Promise<ProviderTurnResult>;
}

export interface ProviderTurnInput {
  system: string;
  messages: LoopMessage[];
  tools: ToolDefinition[];
  maxTokens: number;
  temperature?: number;
}

export type ProviderTurnResult =
  | {
      ok: true;
      content: ContentBlock[];
      stopReason: string | null;
      inputTokens: number;
      outputTokens: number;
      // Prompt-cache usage, when the provider reports it. cacheRead = prefix
      // served from cache (billed ~10% of input); cacheCreation = tokens written
      // to the cache on this turn (billed ~125%). Absent on providers that don't
      // surface it; the loop folds them into the run snapshot for cost analysis.
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

// ── Defaults ────────────────────────────────────────────────────────────────

// Tool use is uncapped by default — the only hard backstop is the orchestrator's
// Temporal activity timeout (start-to-close / heartbeat). Re-impose any cap per
// run with the ANCHORAGE_TOOL_MAX_* env vars (a positive number sets a limit; 0
// or negative means unlimited). `webEnabled` is a capability gate, not a budget.
export const DEFAULT_BUDGET: BudgetConfig = {
  maxTurns: Number.POSITIVE_INFINITY,
  maxInputTokens: Number.POSITIVE_INFINITY,
  maxFiles: Number.POSITIVE_INFINITY,
  maxWebCalls: Number.POSITIVE_INFINITY,
  maxShellCalls: Number.POSITIVE_INFINITY,
  maxWallClockMs: Number.POSITIVE_INFINITY,
  webEnabled: false,
};
