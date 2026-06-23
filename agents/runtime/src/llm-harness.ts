// LLM general path for the isolated component preview. When no deterministic
// template fits the repo (anything that isn't a recognized React project), an
// agentic loop inspects the repo, detects the framework, and scaffolds a minimal
// throwaway harness that renders the changed components in isolation with mock
// data — never booting the app or touching its secrets. The model writes the
// harness files and returns the install + start commands; the deterministic
// caller (index.ts) installs, starts the server detached, and probes it, feeding
// any startup error back here for one repair pass. This is what lets the preview
// work for "any framework" instead of only the ones we hand-template.

import {
  discoveryTools,
  type LlmConfig,
  providerFromLlmConfig,
  ROLE_DEFAULTS,
  repoReadTools,
  repoWriteTools,
  resolveLlmConfig,
  runWithTools,
  shellTools,
  type ToolDefinition,
  type ToolEvent,
} from "@anchorage/agent-llm";
import type { TaskEnvelope } from "@anchorage/sdk";
import type { ComponentEntry } from "./stories.js";

export interface LlmHarnessRequest {
  task: TaskEnvelope;
  workspacePath: string;
  /** Harness dir relative to the repo root (e.g. ".anchorage/preview"). */
  harnessRelDir: string;
  components: ComponentEntry[];
  port: number;
  /** The framework we already detected, when known — a hint, not a constraint. */
  frameworkHint?: string;
  /** A previous startup failure to repair, when this is a retry pass. */
  previousError?: string;
  env: Record<string, string>;
  capabilities: Iterable<string>;
  onEvent?: (event: ToolEvent) => void;
}

export type LlmHarnessResult =
  | { ok: true; framework: string; installCommand: string; startCommand: string }
  | { ok: false; error: string };

const SUBMIT_TOOL = "submit_preview";

const submitPreviewTool: ToolDefinition = {
  name: SUBMIT_TOOL,
  description:
    "Submit the finished harness. Call this exactly once, after you have written all harness files, with the commands to bring it up. Calling it is the only way to finish.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      framework: {
        type: "string",
        description: "The UI framework you detected (e.g. 'react', 'vue', 'svelte', 'solid').",
      },
      installCommand: {
        type: "string",
        description:
          "Command that installs the harness's own dependencies, run with the harness dir as cwd (e.g. 'npm install'). The repository's own dependencies are already installed for you.",
      },
      startCommand: {
        type: "string",
        description:
          "Long-running command that starts the harness dev server on the given port, run with the harness dir as cwd (e.g. 'npm run dev'). Do NOT background it (no '&'); the caller runs it detached.",
      },
      notes: {
        type: "string",
        description: "One line on what you mocked/stubbed to render the components in isolation.",
      },
    },
    required: ["framework", "installCommand", "startCommand"],
  },
  // Terminal tool: intercepted by the loop, handler never runs.
  handler: async () => ({ ok: true, output: "accepted" }),
};

function systemPrompt(): string {
  return [
    "You set up an ISOLATED visual preview of specific changed UI components, so a human can eyeball them before merge.",
    "",
    "HARD CONSTRAINTS:",
    "- NEVER import or start the application's own entry point / server. The app needs secrets (DB, auth, external APIs) you do NOT have; booting it is forbidden and will fail.",
    "- Render ONLY the changed components listed below, each in isolation, with realistic MOCK data/props and mock providers (router, theme, store, data-fetching) as needed. Stub any module a component imports that does network/auth/DB work so it renders offline.",
    "- The harness must be a small, throwaway dev app (prefer Vite) living entirely under the harness directory. Reuse the repository's own framework dependencies (they're installed); keep the harness's own deps minimal.",
    "- INSTALL THE HARNESS WITH npm, and use this exact installCommand: `npm install --no-workspaces --include=dev --production=false`. startCommand: `npm run dev`. Reasons: yarn/pnpm (or plain npm) from this nested dir can attach to a parent WORKSPACE and skip the harness's own deps; and the container runs with NODE_ENV=production, so a plain `npm install` SKIPS devDependencies (you'll get 'vite: not found'). The flags above force the harness's deps in regardless.",
    "- Put the harness's own build deps (vite, the framework plugin) in `dependencies`, NOT `devDependencies`, so they survive NODE_ENV=production.",
    "- It is a VISUAL preview: no real data, no logins, no backend. Better to render with mock data than to wire anything real.",
    "",
    "WORKFLOW:",
    "1. Inspect the repo (package.json, config, the changed component sources) to detect the framework and how a component mounts.",
    "2. Write all harness files under the harness directory using the write tools.",
    "3. Finish by calling the submit_preview tool with the install and start commands. Do not run the long-running dev server yourself — the caller starts it and reports back.",
    "If a previous attempt's startup error is provided, fix the harness so it comes up, then submit again.",
  ].join("\n");
}

function userPrompt(req: LlmHarnessRequest): string {
  const components = req.components.map((c) => `- ${c.absPath}`).join("\n");
  const lines = [
    `Harness directory (write everything here, relative to repo root): ${req.harnessRelDir}`,
    `The dev server must listen on port ${req.port} and bind host 0.0.0.0.`,
  ];
  if (req.frameworkHint) {
    lines.push(
      `Detected framework (a strong hint — verify, but a deterministic ${req.frameworkHint} template already failed to come up, so inspect why): ${req.frameworkHint}.`,
    );
  }
  lines.push("", "Changed components to preview in isolation:", components);
  if (req.previousError) {
    lines.push(
      "",
      "The previous attempt did not come up. Fix the harness so it starts and serves the gallery. Startup error:",
      "```",
      req.previousError.slice(0, 4000),
      "```",
    );
  }
  return lines.join("\n");
}

// Bounds for ONE harness-generation pass. The preview is best-effort; it must
// never hold the run hostage NOR thrash on exploratory tool calls. Building a
// harness needs maybe ~15-40 tool calls (inspect repo, write files, install,
// start, one repair); these are generous backstops against a model that loops
// re-reading/re-grepping. All overridable.
const DEFAULT_HARNESS_TIMEOUT_MS = 240_000;
const DEFAULT_HARNESS_MAX_TURNS = 50;
const DEFAULT_HARNESS_MAX_SHELL_CALLS = 40;

function envInt(env: Record<string, string>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

/** Resolve the runtime role's LLM config, or null when none is configured. */
export function resolveRuntimeLlmConfig(): LlmConfig | null {
  const config = resolveLlmConfig(ROLE_DEFAULTS.runtime);
  return config.ok ? config.value : null;
}

/**
 * Drive the agentic loop that writes the harness. Returns the framework + the
 * install/start commands to run, or an error. The caller owns installing,
 * starting (detached), and probing the server.
 */
export async function generateHarnessWithLlm(
  config: LlmConfig,
  req: LlmHarnessRequest,
): Promise<LlmHarnessResult> {
  const provider = providerFromLlmConfig(config);
  if (!provider.ok) return { ok: false, error: provider.message };

  const tools: ToolDefinition[] = [
    ...discoveryTools,
    ...repoReadTools,
    ...repoWriteTools,
    ...shellTools,
    submitPreviewTool,
  ];

  const result = await runWithTools(provider.value, {
    system: systemPrompt(),
    messages: [{ role: "user", content: userPrompt(req) }],
    tools,
    terminalTool: SUBMIT_TOOL,
    workspacePath: req.workspacePath,
    capabilities: new Set(req.capabilities),
    env: req.env,
    temperature: 0.1,
    // Bound the whole harness-generation loop on wall-clock AND tool calls.
    // Combined with the per-request provider timeout, this guarantees the gate
    // can never hang or thrash — it finishes, fails cleanly, the run continues.
    budget: {
      maxWallClockMs: envInt(
        req.env,
        "ANCHORAGE_RUNTIME_LLM_TIMEOUT_MS",
        DEFAULT_HARNESS_TIMEOUT_MS,
      ),
      maxTurns: envInt(req.env, "ANCHORAGE_RUNTIME_LLM_MAX_TURNS", DEFAULT_HARNESS_MAX_TURNS),
      maxShellCalls: envInt(
        req.env,
        "ANCHORAGE_RUNTIME_LLM_MAX_SHELL",
        DEFAULT_HARNESS_MAX_SHELL_CALLS,
      ),
    },
    ...(req.onEvent ? { onEvent: req.onEvent } : {}),
  });

  if (!result.ok) {
    return { ok: false, error: `harness generation failed: ${result.message}` };
  }
  const final = result.finalToolInput;
  if (!final) {
    return { ok: false, error: "model finished without submitting harness commands" };
  }
  const framework = typeof final.framework === "string" ? final.framework : "unknown";
  const installCommand = typeof final.installCommand === "string" ? final.installCommand : "";
  const startCommand = typeof final.startCommand === "string" ? final.startCommand : "";
  if (!installCommand.trim() || !startCommand.trim()) {
    return { ok: false, error: "model submitted empty install/start command" };
  }
  return { ok: true, framework, installCommand, startCommand };
}
