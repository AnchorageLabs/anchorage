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

export interface ToolContext {
  // Workspace root for the run. Repo-read / shell tools sandbox here.
  workspacePath: string;
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
  webEnabled: boolean;
}

export interface BudgetState extends BudgetConfig {
  turns: number;
  inputTokensTotal: number;
  outputTokensTotal: number;
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
  // Observer for structured tool events; mirrors the protocol's tool.requested
  // / tool.result emission shape so callers can pipe directly to stdout.
  onEvent?: ToolEventEmitter;
}

export interface ContextSnapshot {
  bytesAcquired: number;
  filesRead: string[];
  toolTurns: number;
  webCalls: number;
  shellCalls: number;
  inputTokensTotal: number;
  outputTokensTotal: number;
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
      stopReason: string | null;
      messages: LoopMessage[];
      toolCalls: ToolCallRecord[];
      snapshot: ContextSnapshot;
    }
  | {
      ok: false;
      code: "budget_exceeded" | "provider_error" | "invalid_tool_call" | "model_loop_divergent";
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
  webEnabled: false,
};
