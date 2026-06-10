import { checkTurnBudget, createBudgetState, recordTurn } from "./budget.js";
import { buildToolIndex, filterToolsByCapability } from "./registry.js";
import type {
  AssistantMessage,
  ContentBlock,
  ContextSnapshot,
  JsonObject,
  LoopMessage,
  ProviderAdapter,
  RunWithToolsRequest,
  RunWithToolsResult,
  ToolCallRecord,
  ToolContext,
  ToolDefinition,
  ToolEventEmitter,
  ToolHandlerResult,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.js";

/**
 * Drive a model→tool→model loop until the model returns a terminal message
 * (no tool_use blocks) or a budget is exhausted. Provider-agnostic: the
 * caller injects a `ProviderAdapter` that knows how to talk to Anthropic /
 * OpenAI / Bedrock and translates tool schemas in both directions.
 *
 * Events: every dispatched tool emits one `tool.requested` and one
 * `tool.result` via `request.onEvent`. The shape mirrors the Anchorage
 * protocol event payload so callers can stream them straight to stdout.
 */
export async function runWithTools(
  provider: ProviderAdapter,
  request: RunWithToolsRequest,
): Promise<RunWithToolsResult> {
  const budget = createBudgetState(request.budget);
  const capabilities = new Set(request.capabilities ?? []);
  const env = request.env ?? {};
  const emit: ToolEventEmitter = request.onEvent ?? (() => {});

  const availableTools = filterToolsByCapability(request.tools, capabilities);
  const toolIndex = buildToolIndex(availableTools);

  const messages: LoopMessage[] = [...request.messages];
  const toolCalls: ToolCallRecord[] = [];
  let terminalNudgeUsed = false;

  while (true) {
    const turnCheck = checkTurnBudget(budget);
    if (!turnCheck.ok) {
      return {
        ok: false,
        code: "budget_exceeded",
        message: turnCheck.message ?? "Tool budget exceeded.",
        reason: turnCheck.reason,
        messages,
        toolCalls,
        snapshot: snapshotOf(budget, toolCalls),
      };
    }

    const turnResult = await provider.requestTurn({
      system: request.system,
      messages,
      tools: availableTools,
      maxTokens: request.maxTokensPerTurn ?? 4096,
      temperature: request.temperature,
    });

    if (!turnResult.ok) {
      return {
        ok: false,
        code: "provider_error",
        message: `${provider.name} (${provider.model}): ${turnResult.message}`,
        messages,
        toolCalls,
        snapshot: snapshotOf(budget, toolCalls),
      };
    }

    recordTurn(budget, turnResult.inputTokens, turnResult.outputTokens);

    const assistantMessage: AssistantMessage = {
      role: "assistant",
      content: turnResult.content,
    };
    messages.push(assistantMessage);

    const toolUses = turnResult.content.filter(isToolUseBlock);

    // Terminal-tool mode: the named call ends the loop and its input IS the
    // result. It is never dispatched to a handler, but it still emits the
    // standard event pair so the ledger records how the run finished. If the
    // model bundled other tool calls into the same turn they are not executed —
    // the answer has already been submitted.
    const terminalUse = request.terminalTool
      ? toolUses.find((use) => use.name === request.terminalTool)
      : undefined;
    if (terminalUse) {
      const turnNumber = budget.turns;
      emit({
        kind: "tool.requested",
        tool: terminalUse.name,
        input: boundInputForEvent(terminalUse.input),
        turn: turnNumber,
      });
      emit({
        kind: "tool.result",
        tool: terminalUse.name,
        success: true,
        durationMs: 0,
        output: { ok: true, accepted: true },
        turn: turnNumber,
      });
      toolCalls.push({
        name: terminalUse.name,
        input: terminalUse.input,
        ok: true,
        durationMs: 0,
        turn: turnNumber,
      });
      return {
        ok: true,
        finalText: extractText(turnResult.content),
        finalToolInput: terminalUse.input,
        stopReason: turnResult.stopReason,
        messages,
        toolCalls,
        snapshot: snapshotOf(budget, toolCalls),
      };
    }

    if (toolUses.length === 0) {
      if (request.terminalTool) {
        // The model tried to finish with plain text. Nudge it once — a cheap
        // correction beats failing the whole run — then give up so a divergent
        // model can't loop forever.
        if (!terminalNudgeUsed) {
          terminalNudgeUsed = true;
          messages.push({
            role: "user",
            content: `You must finish by calling the \`${request.terminalTool}\` tool with your final answer. Plain text answers are not accepted. Call it now.`,
          });
          continue;
        }
        return {
          ok: false,
          code: "terminal_tool_not_called",
          message: `Model ended with text twice without calling required terminal tool '${request.terminalTool}'.`,
          messages,
          toolCalls,
          snapshot: snapshotOf(budget, toolCalls),
        };
      }
      // Terminal turn — no tool calls; return the model's final text.
      const finalText = extractText(turnResult.content);
      return {
        ok: true,
        finalText,
        stopReason: turnResult.stopReason,
        messages,
        toolCalls,
        snapshot: snapshotOf(budget, toolCalls),
      };
    }

    // Dispatch each requested tool sequentially. Anthropic and OpenAI both
    // accept multiple tool_use blocks per turn; serializing keeps budget
    // accounting trivial and avoids racy filesystem writes.
    const resultBlocks: ToolResultBlock[] = [];
    for (const use of toolUses) {
      const tool = toolIndex.get(use.name);
      const turnNumber = budget.turns;

      emit({
        kind: "tool.requested",
        tool: use.name,
        // Bound the echoed input: a large argument (e.g. write_file content) must
        // not become a multi-hundred-KB NDJSON event line that bloats the run log
        // or trips strict stream parsing. The tool handler below still receives
        // the full, untouched `use.input`.
        input: boundInputForEvent(use.input),
        turn: turnNumber,
      });

      const startedAt = Date.now();
      let outcome: ToolHandlerResult;
      if (!tool) {
        outcome = {
          ok: false,
          code: "unknown_tool",
          message: `Tool '${use.name}' is not available on this run.`,
        };
      } else {
        const ctx: ToolContext = {
          workspacePath: request.workspacePath,
          contextRepos: request.contextRepos,
          capabilities,
          env,
          budget,
          emit,
          log: () => {},
        };
        try {
          outcome = await tool.handler(use.input, ctx);
        } catch (error) {
          outcome = {
            ok: false,
            code: "tool_threw",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }
      const durationMs = Date.now() - startedAt;

      const resultPayload: JsonObject = outcome.ok
        ? {
            ok: true,
            // Truncated preview for the event ledger; the model gets the full
            // content via the tool_result block on the next turn.
            preview: previewOf(outcome.output),
            ...(outcome.meta ? { meta: outcome.meta } : {}),
          }
        : { ok: false, error: { code: outcome.code, message: outcome.message } };

      emit({
        kind: "tool.result",
        tool: use.name,
        success: outcome.ok,
        durationMs,
        output: resultPayload,
        turn: turnNumber,
      });

      toolCalls.push({
        name: use.name,
        input: use.input,
        ok: outcome.ok,
        durationMs,
        turn: turnNumber,
      });

      resultBlocks.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: outcome.ok ? outcome.output : `${outcome.code}: ${outcome.message}`,
        ...(outcome.ok ? {} : { is_error: true }),
      });
    }

    messages.push({ role: "user", content: resultBlocks });
  }
}

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === "tool_use";
}

function extractText(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
}

// Max serialized size of a tool input echoed into a `tool.requested` event.
// Beyond this the input is replaced with a bounded preview so a single event
// line stays small regardless of how large the model's argument is.
const MAX_EVENT_INPUT_BYTES = 4096;

function boundInputForEvent(input: JsonObject): JsonObject {
  const json = JSON.stringify(input);
  if (json.length <= MAX_EVENT_INPUT_BYTES) return input;
  return {
    _truncated: true,
    _bytes: json.length,
    preview: `${json.slice(0, MAX_EVENT_INPUT_BYTES)}…`,
  };
}

function previewOf(output: string | ContentBlock[]): string {
  const text = typeof output === "string" ? output : extractText(output);
  if (text.length <= 200) return text;
  return `${text.slice(0, 200)}…`;
}

function snapshotOf(
  budget: {
    bytesAcquired: number;
    filesRead: Set<string>;
    maxFiles: number;
    turns: number;
    webCalls: number;
    shellCalls: number;
    inputTokensTotal: number;
    outputTokensTotal: number;
  },
  toolCalls: ToolCallRecord[],
): ContextSnapshot {
  const miss = computeMissSignals(budget, toolCalls);
  return {
    bytesAcquired: budget.bytesAcquired,
    filesRead: [...budget.filesRead].sort(),
    toolTurns: budget.turns,
    webCalls: budget.webCalls,
    shellCalls: budget.shellCalls,
    inputTokensTotal: budget.inputTokensTotal,
    outputTokensTotal: budget.outputTokensTotal,
    filesReadCapHit: miss.filesReadCapHit,
    repeatedSymbolGrep: miss.repeatedSymbolGrep,
    grepReadChurn: miss.grepReadChurn,
  };
}

// Derive the context-miss signals (see ContextSnapshot) from the budget state
// and the ordered tool-call record. Pure over its inputs; no side effects.
function computeMissSignals(
  budget: { filesRead: Set<string>; maxFiles: number },
  toolCalls: ToolCallRecord[],
): { filesReadCapHit: boolean; repeatedSymbolGrep: number; grepReadChurn: number } {
  const filesReadCapHit =
    Number.isFinite(budget.maxFiles) && budget.filesRead.size >= budget.maxFiles;

  let grepReadChurn = 0;
  let repeatedSymbolGrep = 0;
  const seenPatterns = new Set<string>();

  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i];
    if (!call || call.name !== "grep") continue;
    const pattern = typeof call.input.pattern === "string" ? call.input.pattern : "";
    if (pattern.length > 0) {
      // Every grep past the first for a given pattern counts as a repeat.
      if (seenPatterns.has(pattern)) repeatedSymbolGrep += 1;
      else seenPatterns.add(pattern);
    }
    if (toolCalls[i + 1]?.name === "read_file") grepReadChurn += 1;
  }

  return { filesReadCapHit, repeatedSymbolGrep, grepReadChurn };
}

// Re-export ToolDefinition as a helper alias so consumers can use the same
// name without a deep import.
export type { ToolDefinition };
