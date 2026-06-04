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
        snapshot: snapshotOf(budget),
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
        snapshot: snapshotOf(budget),
      };
    }

    recordTurn(budget, turnResult.inputTokens, turnResult.outputTokens);

    const assistantMessage: AssistantMessage = {
      role: "assistant",
      content: turnResult.content,
    };
    messages.push(assistantMessage);

    const toolUses = turnResult.content.filter(isToolUseBlock);
    if (toolUses.length === 0) {
      // Terminal turn — no tool calls; return the model's final text.
      const finalText = extractText(turnResult.content);
      return {
        ok: true,
        finalText,
        stopReason: turnResult.stopReason,
        messages,
        toolCalls,
        snapshot: snapshotOf(budget),
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
        input: use.input,
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

function previewOf(output: string | ContentBlock[]): string {
  const text = typeof output === "string" ? output : extractText(output);
  if (text.length <= 200) return text;
  return `${text.slice(0, 200)}…`;
}

function snapshotOf(budget: {
  bytesAcquired: number;
  filesRead: Set<string>;
  turns: number;
  webCalls: number;
  shellCalls: number;
  inputTokensTotal: number;
  outputTokensTotal: number;
}): ContextSnapshot {
  return {
    bytesAcquired: budget.bytesAcquired,
    filesRead: [...budget.filesRead].sort(),
    toolTurns: budget.turns,
    webCalls: budget.webCalls,
    shellCalls: budget.shellCalls,
    inputTokensTotal: budget.inputTokensTotal,
    outputTokensTotal: budget.outputTokensTotal,
  };
}

// Re-export ToolDefinition as a helper alias so consumers can use the same
// name without a deep import.
export type { ToolDefinition };
