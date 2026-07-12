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
  // Consecutive turns that ended with NO tool calls because the model was cut
  // off at the output-token limit (stopReason "length"/"max_tokens"). A
  // truncated turn is NOT a finished answer — the model ran out of room mid-
  // response, frequently before it could emit its edits — so it must not be
  // treated as a clean terminal turn (that is how a coder produces an empty,
  // false "no changes"/"already implemented" result). We prod it to continue;
  // a turn that DOES make tool calls resets the counter, so a run that keeps
  // making progress but happens to truncate is never penalized.
  let truncatedContinues = 0;

  // Lossless history dedup: agents routinely re-read a file or re-run a grep
  // they already issued (the repeatedSymbolGrep / grepReadChurn signals measure
  // exactly this). When a tool produces output byte-for-byte identical to an
  // earlier result THIS RUN, the duplicate copy is replaced with a short
  // back-reference — the full content is still present once, earlier in the
  // conversation, so the model loses nothing. Only the newest result is ever
  // rewritten; history stays byte-identical, so a written cache prefix keeps
  // hitting. Maps identical output → the tool name of its first occurrence.
  const dedupEnabled = !/^(false|0|no|off)$/i.test((env.ANCHORAGE_TOOL_DEDUP ?? "").trim());
  const seenOutputs = new Map<string, string>();

  // Emergency context compaction: drop the oldest large tool outputs only when
  // the context nears the model's window (see compactToolResults). Resolved once;
  // applied at the top of each turn. Null = disabled.
  const compactOpts = resolveCompactOpts(env);
  let compactedTotal = 0;

  // Context-miss guard: turn the diagnostic signals (repeatedSymbolGrep,
  // grepReadChurn, filesReadCapHit) into in-loop action instead of end-of-run
  // instrumentation. SAFE TIER (default on): the first time a signal fires,
  // append a one-time, clearly-marked nudge to that tool's result steering the
  // model to the precise tools (find_references / impact / repo_map). It only
  // adds guidance — removes nothing — so it cannot degrade the run. AGGRESSIVE
  // TIER (opt-in via ANCHORAGE_TOOL_CONTEXT_ENFORCE, default OFF): a grep
  // repeating a pattern already searched is refused before dispatch. Left off by
  // default so the standard pipeline is never blocked from a legitimate re-grep.
  const nudgeEnabled = !/^(false|0|no|off)$/i.test((env.ANCHORAGE_TOOL_CONTEXT_NUDGE ?? "").trim());
  const enforceEnabled = /^(true|1|yes|on)$/i.test(
    (env.ANCHORAGE_TOOL_CONTEXT_ENFORCE ?? "").trim(),
  );
  const seenGrepPatterns = new Set<string>();
  // Repeat backstop (always on — a runaway-cost guard, not an opt-in tier):
  // ANY tool call that keeps returning the SAME output for the SAME input is a
  // stuck loop. Observed twice on the same task: a coder ran `ls node_modules/…`
  // 230× (a dep was missing so it couldn't typecheck), and later re-read one file
  // 333× until the conversation blew past the model's 262K context window and the
  // request 400'd. Track, per (tool + input), the last output and how many times
  // in a row it repeated UNCHANGED; refuse once it exceeds the limit. Keyed on
  // identical output, so a productive loop whose result changes (a build whose
  // error list shrinks, a file re-read after an edit) resets and never trips.
  const repeatLastOutput = new Map<string, string>();
  const repeatUnproductiveRuns = new Map<string, number>();
  const nudgesFired = new Set<string>();
  let grepReadChurn = 0;
  let prevToolName: string | null = null;

  while (true) {
    // Before asking the model: if the conversation is nearing the context
    // window, drop the oldest large tool outputs so the request doesn't 400 on
    // "maximum context length". No-op on normal-sized contexts.
    if (compactOpts) {
      const dropped = compactToolResults(messages, compactOpts);
      if (dropped > 0) {
        compactedTotal += dropped;
        // Observable (stderr keeps stdout's NDJSON protocol clean), not swallowed.
        console.error(
          `[context-compaction] dropped ${dropped} old tool output(s) to fit the context window (${compactedTotal} total this run)`,
        );
      }
    }

    const turnCheck = checkTurnBudget(budget);
    if (!turnCheck.ok) {
      return {
        ok: false,
        code: "budget_exceeded",
        message: turnCheck.message ?? "Tool budget exceeded.",
        reason: turnCheck.reason,
        messages,
        toolCalls,
        snapshot: snapshotOf(budget, toolCalls, [...nudgesFired]),
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
        snapshot: snapshotOf(budget, toolCalls, [...nudgesFired]),
      };
    }

    recordTurn(
      budget,
      turnResult.inputTokens,
      turnResult.outputTokens,
      turnResult.cacheReadInputTokens ?? 0,
      turnResult.cacheCreationInputTokens ?? 0,
    );

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
        snapshot: snapshotOf(budget, toolCalls, [...nudgesFired]),
      };
    }

    if (toolUses.length === 0) {
      // Truncated-at-length turn with nothing to show. The model was cut off by
      // the per-turn output cap before finishing (and before emitting any tool
      // call), so this is an INCOMPLETE turn, not a terminal one. Prod it to
      // continue where it left off; only after it keeps truncating with no
      // progress do we fail explicitly — never silently return ok:true with a
      // partial answer, which downstream reads as an empty diff / "no changes".
      if (isTruncatedStop(turnResult.stopReason)) {
        if (truncatedContinues < MAX_TRUNCATION_CONTINUES) {
          truncatedContinues += 1;
          messages.push({
            role: "user",
            content:
              "Your previous message was cut off at the output-token limit before it was " +
              "complete. Continue from exactly where you stopped. Keep any remaining prose short " +
              "and make the concrete tool calls (e.g. edit_file / write_file) needed to finish — " +
              "do not restate your plan or repeat what you already wrote.",
          });
          continue;
        }
        return {
          ok: false,
          code: "output_truncated",
          message:
            `${provider.name} (${provider.model}) repeatedly hit the output-token limit ` +
            `(stopReason '${turnResult.stopReason}') without completing — it produced no final ` +
            `answer and no tool calls, so no change was applied. Raise ` +
            `ANCHORAGE_CODER_MAX_TOKENS_PER_TURN or use a less verbose model.`,
          messages,
          toolCalls,
          snapshot: snapshotOf(budget, toolCalls, [...nudgesFired]),
        };
      }
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
          snapshot: snapshotOf(budget, toolCalls, [...nudgesFired]),
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
        snapshot: snapshotOf(budget, toolCalls, [...nudgesFired]),
      };
    }

    // The model acted this turn — real progress — so a prior length-truncation
    // no longer counts against it: reset the consecutive-truncation guard.
    truncatedContinues = 0;

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

      const grepPattern =
        use.name === "grep" && typeof use.input.pattern === "string" ? use.input.pattern : null;
      const duplicateGrep = grepPattern !== null && seenGrepPatterns.has(grepPattern);

      // Repeat-backstop key: same tool + same input. Bounded so a large
      // write_file body can't make an unbounded Map key (a prefix collision only
      // ever means two near-identical calls share a counter — harmless).
      const repeatKey = `${use.name} ${JSON.stringify(use.input ?? {}).slice(0, 2000)}`;
      const repeatingUnchanged =
        (repeatUnproductiveRuns.get(repeatKey) ?? 0) >= REPEAT_BACKSTOP_LIMIT;

      const startedAt = Date.now();
      let outcome: ToolHandlerResult;
      if (repeatingUnchanged) {
        // Runaway backstop: this exact call has already returned the same result
        // several times this run. Refuse rather than let a stuck loop burn the
        // tool budget AND the context window — a re-read that never changes still
        // reinflates the conversation and can 400 the model on max context length.
        outcome = {
          ok: false,
          code: "repeat_backstop",
          message:
            `This ${use.name} call has already returned the same result ${REPEAT_BACKSTOP_LIMIT} ` +
            `times this run — repeating it changes nothing and only grows the context. Use the result ` +
            `already shown above. If you are blocked (a missing dependency, an unrunnable command, a ` +
            `file that does not have what you expect), record it in 'risks' and finish instead of retrying.`,
        };
      } else if (enforceEnabled && duplicateGrep) {
        // Aggressive tier (opt-in): refuse a grep that repeats a pattern already
        // searched this run — it would return the same matches.
        outcome = {
          ok: false,
          code: "context_guard_duplicate_grep",
          message:
            `You already ran grep for /${grepPattern}/ this run; re-running returns the same ` +
            `matches. Use find_references or impact to resolve a named symbol, or repo_map for ` +
            `an overview. (Set ANCHORAGE_TOOL_CONTEXT_ENFORCE=false to allow repeats.)`,
        };
      } else if (!tool) {
        outcome = {
          ok: false,
          code: "unknown_tool",
          message: `Tool '${use.name}' is not available on this run.`,
        };
      } else {
        const ctx: ToolContext = {
          workspacePath: request.workspacePath,
          contextRepos: request.contextRepos,
          artifacts: request.artifacts,
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

      // Repeat-backstop bookkeeping: count consecutive identical-output runs of
      // this exact (tool, input). Uses the raw outcome (before the nudge/dedup
      // rewrite of `content` below) and the FULL output — not a short preview —
      // so an edit deep in a large file still reads as "changed" and resets the
      // counter. Skipped when we just refused the call.
      if (!repeatingUnchanged) {
        const outStr = outcome.ok
          ? typeof outcome.output === "string"
            ? outcome.output
            : extractText(outcome.output)
          : `${outcome.code}: ${outcome.message}`;
        const repeatedUnchanged = repeatLastOutput.get(repeatKey) === outStr;
        repeatUnproductiveRuns.set(
          repeatKey,
          repeatedUnchanged ? (repeatUnproductiveRuns.get(repeatKey) ?? 0) + 1 : 0,
        );
        repeatLastOutput.set(repeatKey, outStr);
      }

      let content: string | ContentBlock[] = outcome.ok
        ? outcome.output
        : `${outcome.code}: ${outcome.message}`;
      // Dedup only successful, sizeable, string outputs: errors carry per-call
      // context, and collapsing a tiny output would cost more than it saves.
      if (
        outcome.ok &&
        dedupEnabled &&
        typeof content === "string" &&
        content.length >= DEDUP_MIN_BYTES
      ) {
        const priorTool = seenOutputs.get(content);
        if (priorTool !== undefined) content = dedupNotice(priorTool);
        else seenOutputs.set(content, use.name);
      }

      // ── Context-miss signals → one-time lossless nudge ──────────────────────
      // Track grep→read_file churn across calls/turns.
      if (use.name === "read_file" && prevToolName === "grep") grepReadChurn += 1;
      // Pick the first applicable signal (most specific first). repeated_grep is
      // skipped under enforce mode — there the duplicate was already refused.
      let signal: string | null = null;
      if (duplicateGrep && !enforceEnabled) signal = "repeated_grep";
      else if (grepReadChurn >= CONTEXT_CHURN_NUDGE_AT) signal = "grep_read_churn";
      else if (Number.isFinite(budget.maxFiles) && budget.filesRead.size >= budget.maxFiles)
        signal = "files_read_cap";
      if (nudgeEnabled && signal && !nudgesFired.has(signal) && typeof content === "string") {
        nudgesFired.add(signal);
        content = `${content}\n\n${contextNudge(signal)}`;
      }
      if (grepPattern !== null) seenGrepPatterns.add(grepPattern);
      prevToolName = use.name;

      resultBlocks.push({
        type: "tool_result",
        tool_use_id: use.id,
        content,
        ...(outcome.ok ? {} : { is_error: true }),
      });
    }

    messages.push({ role: "user", content: resultBlocks });
  }
}

// Minimum output size worth deduping. Below this the back-reference notice
// would be comparable to (or larger than) the content it replaces.
const DEDUP_MIN_BYTES = 500;

// ── Context compaction (emergency, opt-out) ──────────────────────────────────
// In a LONG run the accumulated tool outputs (build logs, file reads, test
// output) can approach the model's context window — the failure mode that 400'd
// a real run at 262 144 tokens ("maximum context length ... however you
// requested ..."). When the estimated context crosses COMPACT_AT tokens, the
// CONTENT of the OLDEST tool results is dropped (the most recent COMPACT_KEEP are
// kept intact) down to COMPACT_TARGET, each replaced with a short placeholder.
// This trades cache-prefix stability for survival, deliberately:
//   - It only fires on LARGE contexts, so normal runs are untouched and their
//     cache prefix keeps hitting (the common case pays nothing).
//   - It over-trims to TARGET in one pass, so it does not re-truncate a little
//     every turn (which would move the prefix each turn and thrash the cache).
//   - The dropped output is reproducible: the model can re-run the tool.
// Tunable via ANCHORAGE_CONTEXT_COMPACT_AT / _TARGET / _KEEP; off via
// ANCHORAGE_CONTEXT_COMPACT=false.
const COMPACT_MIN_BYTES = 800; // only sizeable outputs are worth dropping
const COMPACT_PLACEHOLDER =
  "[older tool output dropped to fit the context window — re-run the tool if you need this result again]";

function estimateContextTokens(messages: LoopMessage[]): number {
  let bytes = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      bytes += m.content.length;
      continue;
    }
    for (const b of m.content) {
      if (b.type === "text") bytes += b.text.length;
      else if (b.type === "tool_result")
        bytes +=
          typeof b.content === "string" ? b.content.length : JSON.stringify(b.content).length;
      else bytes += JSON.stringify(b).length;
    }
  }
  return Math.ceil(bytes / 4); // ~4 bytes per token — a deliberate over-estimate
}

interface CompactOpts {
  compactAt: number;
  target: number;
  keepRecent: number;
}

/**
 * Drop the oldest large tool-result CONTENT when the context is near the window.
 * Mutates `messages` in place; returns the number of results dropped (0 = no-op).
 * Keeps the newest `keepRecent` tool results, the assistant turns, and small
 * results untouched.
 */
function compactToolResults(messages: LoopMessage[], opts: CompactOpts): number {
  if (estimateContextTokens(messages) < opts.compactAt) return 0;

  // Every tool_result block in order, so we can keep the newest and drop oldest.
  const blocks: ToolResultBlock[] = [];
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "tool_result") blocks.push(b);
  }
  const droppableEnd = Math.max(0, blocks.length - opts.keepRecent);
  let dropped = 0;
  for (let i = 0; i < droppableEnd; i++) {
    if (estimateContextTokens(messages) <= opts.target) break;
    const b = blocks[i];
    if (!b || typeof b.content !== "string" || b.content.length < COMPACT_MIN_BYTES) continue;
    if (b.content === COMPACT_PLACEHOLDER) continue; // already dropped
    b.content = COMPACT_PLACEHOLDER;
    dropped++;
  }
  return dropped;
}

function resolveCompactOpts(env: Record<string, string | undefined>): CompactOpts | null {
  if (/^(false|0|no|off)$/i.test((env.ANCHORAGE_CONTEXT_COMPACT ?? "").trim())) return null;
  const num = (v: string | undefined, d: number): number => {
    const n = Number.parseInt((v ?? "").trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  // Default 160k fires below a 200k window (Claude) with margin, and well below
  // 256k (kimi) — the model that actually hit the wall. Target 96k = 60%.
  return {
    compactAt: num(env.ANCHORAGE_CONTEXT_COMPACT_AT, 160_000),
    target: num(env.ANCHORAGE_CONTEXT_COMPACT_TARGET, 96_000),
    keepRecent: num(env.ANCHORAGE_CONTEXT_COMPACT_KEEP, 8),
  };
}

function dedupNotice(priorTool: string): string {
  return (
    `[Repeated content omitted to save context: byte-for-byte identical to the ` +
    `output of an earlier \`${priorTool}\` call already shown above in this ` +
    `conversation. Refer to that earlier result.]`
  );
}

// After this many grep→read_file adjacencies, nudge once toward symbol tools.
const CONTEXT_CHURN_NUDGE_AT = 3;

// Any tool call (shell_exec, read_file, grep, …) that returns identical output
// for identical input this many times in a row is treated as a stuck loop and
// refused on the next repeat. Generous enough that a normal fix→verify cycle
// (whose output changes as the code changes, so its counter keeps resetting)
// never trips it; low enough to kill a 200+ repeat spiral early — including the
// re-read loop that blew past the model's context window.
const REPEAT_BACKSTOP_LIMIT = 3;

// One-time guidance appended to a tool result when a context-miss signal fires.
// Purely additive — it suggests cheaper tools, never withholds anything.
function contextNudge(signal: string): string {
  switch (signal) {
    case "repeated_grep":
      return (
        "[context guard] You've grepped this pattern before in this run. To locate where a " +
        "named symbol is defined or used, `find_references` and `impact` are exact (and cheaper " +
        "than re-grepping); `repo_map` gives a one-call overview of the core files. Guidance only."
      );
    case "grep_read_churn":
      return (
        "[context guard] You're alternating grep → read_file repeatedly. `find_references` / " +
        "`impact` return a symbol's definition and call sites directly, and `repo_map` ranks the " +
        "most-depended-on files — using them will cut the back-and-forth. Guidance only."
      );
    case "files_read_cap":
      return (
        "[context guard] You're near the unique-file read cap for this run. Prefer `impact` / " +
        "`tests_for` / `repo_map` to target the few files that matter rather than reading more " +
        "broadly. Guidance only."
      );
    default:
      return "[context guard] Consider find_references / impact / repo_map to narrow context.";
  }
}

// Max consecutive length-truncated turns (no tool calls) we prod to continue
// before failing the run honestly. A turn that makes a tool call resets the
// count, so this only trips when a model keeps emitting truncated prose without
// ever acting — not on a run that is truncating but still making progress.
const MAX_TRUNCATION_CONTINUES = 3;

// True when a turn ended because it hit the output-token cap rather than because
// the model chose to stop. Provider-agnostic: OpenAI/OpenRouter report "length",
// Anthropic "max_tokens", Bedrock "max_tokens" — all mean the same truncation.
function isTruncatedStop(stopReason: string | null): boolean {
  if (!stopReason) return false;
  return /^(length|max_tokens|max_output_tokens|model_length)$/i.test(stopReason.trim());
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
    cacheReadInputTokensTotal: number;
    cacheCreationInputTokensTotal: number;
  },
  toolCalls: ToolCallRecord[],
  nudgesFired: string[],
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
    cacheReadInputTokensTotal: budget.cacheReadInputTokensTotal,
    cacheCreationInputTokensTotal: budget.cacheCreationInputTokensTotal,
    filesReadCapHit: miss.filesReadCapHit,
    repeatedSymbolGrep: miss.repeatedSymbolGrep,
    grepReadChurn: miss.grepReadChurn,
    contextNudges: nudgesFired,
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
