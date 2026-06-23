import {
  type BudgetConfig,
  type BudgetExceededReason,
  type BudgetState,
  DEFAULT_BUDGET,
} from "./types.js";

export function createBudgetState(overrides: Partial<BudgetConfig> = {}): BudgetState {
  const config: BudgetConfig = {
    maxTurns: pickInt(overrides.maxTurns, DEFAULT_BUDGET.maxTurns, "ANCHORAGE_TOOL_MAX_TURNS"),
    maxInputTokens: pickInt(
      overrides.maxInputTokens,
      DEFAULT_BUDGET.maxInputTokens,
      "ANCHORAGE_TOOL_MAX_INPUT_TOKENS",
    ),
    maxFiles: pickInt(overrides.maxFiles, DEFAULT_BUDGET.maxFiles, "ANCHORAGE_TOOL_MAX_FILES"),
    maxWebCalls: pickInt(
      overrides.maxWebCalls,
      DEFAULT_BUDGET.maxWebCalls,
      "ANCHORAGE_TOOL_MAX_WEB_CALLS",
    ),
    maxShellCalls: pickInt(
      overrides.maxShellCalls,
      DEFAULT_BUDGET.maxShellCalls,
      "ANCHORAGE_TOOL_MAX_SHELL_CALLS",
    ),
    maxWallClockMs: pickInt(
      overrides.maxWallClockMs,
      DEFAULT_BUDGET.maxWallClockMs,
      "ANCHORAGE_TOOL_MAX_WALL_CLOCK_MS",
    ),
    webEnabled: pickBool(
      overrides.webEnabled,
      DEFAULT_BUDGET.webEnabled,
      "ANCHORAGE_TOOL_WEB_ENABLED",
    ),
  };

  return {
    ...config,
    deadlineMs: Number.isFinite(config.maxWallClockMs)
      ? Date.now() + config.maxWallClockMs
      : Number.POSITIVE_INFINITY,
    turns: 0,
    inputTokensTotal: 0,
    outputTokensTotal: 0,
    cacheReadInputTokensTotal: 0,
    cacheCreationInputTokensTotal: 0,
    filesRead: new Set<string>(),
    webCalls: 0,
    shellCalls: 0,
    bytesAcquired: 0,
  };
}

export interface BudgetCheck {
  ok: boolean;
  reason?: BudgetExceededReason;
  message?: string;
}

export function checkTurnBudget(state: BudgetState): BudgetCheck {
  if (Date.now() >= state.deadlineMs) {
    return {
      ok: false,
      reason: "max_wall_clock",
      message: `Tool loop exceeded its wall-clock budget (${Math.round(state.maxWallClockMs / 1000)}s).`,
    };
  }
  if (state.turns >= state.maxTurns) {
    return {
      ok: false,
      reason: "max_turns",
      message: `Tool loop exceeded max turns (${state.maxTurns}).`,
    };
  }
  if (state.inputTokensTotal >= state.maxInputTokens) {
    return {
      ok: false,
      reason: "max_input_tokens",
      message: `Tool loop exceeded max input tokens (${state.maxInputTokens}).`,
    };
  }
  return { ok: true };
}

export function checkFileBudget(state: BudgetState, path: string): BudgetCheck {
  if (state.filesRead.has(path)) return { ok: true };
  if (state.filesRead.size >= state.maxFiles) {
    return {
      ok: false,
      reason: "max_files",
      message: `Tool loop exceeded max unique files (${state.maxFiles}).`,
    };
  }
  return { ok: true };
}

export function checkWebBudget(state: BudgetState): BudgetCheck {
  if (!state.webEnabled) {
    return {
      ok: false,
      reason: "web_disabled",
      message: "Web tools are disabled for this run (ANCHORAGE_TOOL_WEB_ENABLED=false).",
    };
  }
  if (state.webCalls >= state.maxWebCalls) {
    return {
      ok: false,
      reason: "max_web_calls",
      message: `Tool loop exceeded max web calls (${state.maxWebCalls}).`,
    };
  }
  return { ok: true };
}

export function checkShellBudget(state: BudgetState): BudgetCheck {
  if (state.shellCalls >= state.maxShellCalls) {
    return {
      ok: false,
      reason: "max_shell_calls",
      message: `Tool loop exceeded max shell invocations (${state.maxShellCalls}).`,
    };
  }
  return { ok: true };
}

export function recordFile(state: BudgetState, path: string, bytes: number): void {
  state.filesRead.add(path);
  state.bytesAcquired += bytes;
}

export function recordWeb(state: BudgetState, bytes: number): void {
  state.webCalls += 1;
  state.bytesAcquired += bytes;
}

export function recordShell(state: BudgetState, bytes: number): void {
  state.shellCalls += 1;
  state.bytesAcquired += bytes;
}

export function recordTurn(
  state: BudgetState,
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens = 0,
  cacheCreationInputTokens = 0,
): void {
  state.turns += 1;
  state.inputTokensTotal += inputTokens;
  state.outputTokensTotal += outputTokens;
  state.cacheReadInputTokensTotal += cacheReadInputTokens;
  state.cacheCreationInputTokensTotal += cacheCreationInputTokens;
}

// A positive value sets an explicit cap; 0 or negative means "unlimited"
// (Number.POSITIVE_INFINITY, so the `>=` budget checks never trip). An unset /
// blank / non-numeric env falls back to the default.
function pickInt(override: number | undefined, fallback: number, envName: string): number {
  if (typeof override === "number" && Number.isFinite(override)) {
    return override > 0 ? override : Number.POSITIVE_INFINITY;
  }
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim().length > 0) {
    const parsed = Number(fromEnv);
    if (Number.isFinite(parsed)) return parsed > 0 ? parsed : Number.POSITIVE_INFINITY;
  }
  return fallback;
}

function pickBool(override: boolean | undefined, fallback: boolean, envName: string): boolean {
  if (typeof override === "boolean") return override;
  const fromEnv = process.env[envName];
  if (fromEnv === undefined) return fallback;
  return /^(true|1|yes|on)$/i.test(fromEnv);
}

/**
 * Whether web tools (web_search / web_fetch / github_search_issues) are enabled
 * for this process, by the same `ANCHORAGE_TOOL_WEB_ENABLED` gate the budget
 * uses to refuse web calls. Exposed so agents can avoid OFFERING or ADVERTISING
 * web tools the budget will only reject at call time — otherwise the model
 * burns turns calling tools that always fail with `web_disabled`.
 */
export function webToolsEnabled(): boolean {
  return pickBool(undefined, DEFAULT_BUDGET.webEnabled, "ANCHORAGE_TOOL_WEB_ENABLED");
}
