#!/usr/bin/env node
import {
  type ConnectorStatus,
  type LlmStatus,
  OrchestratorClient,
  type RunSummary,
  type SourceSummary,
} from "./client.js";
/**
 * anchorage — the unified orchestrator CLI: submit and watch runs,
 * approve/reject gates, inspect diffs, and manage connectors, all over the
 * orchestrator REST API.
 *
 * Server + auth resolution: --server flag, then env, then
 * ~/.config/anchoragelabs/cli.json, then the public API. The secret is never a flag.
 */
import { loadConfig, saveConfig } from "./config.js";

const CLI_VERSION = "0.1.1";

// ── tiny arg parsing (no external deps) ──────────────────────────────────────

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

// Flags that take no value — so they never swallow the following positional
// (e.g. `--json connectors status` must not read "connectors" as --json's value).
const BOOLEAN_FLAGS = new Set(["json", "help", "version"]);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function str(flags: Args["flags"], key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

const USAGE = `anchorage — orchestrator CLI

Usage: anchorage [--server <url>] [--json] <command>

Version: anchorage --version

Commands:
  auth login                 Save server URL (+ secret from env/stdin) to the config file
  auth whoami                Show the credential the server sees
  auth token                 Rotate (issue) your own API token — shown once, invalidates the previous
  runs list                  List recent runs
  runs start --repo <o/r>    Start a run (--issue N | --instruction "...") [--workflow W] [--branch b] [--llm-provider p] [--llm-model m]
  runs review <pr> --repo <o/r>  Review a PR by number: post a review + open a stacked fix-PR with the must-fix changes
  runs status <id>           Show a run's status
  runs watch <id>            Stream a run's events until it ends
  runs approve <id>          Approve a paused run
  runs reject <id>           Reject a paused run
  runs cancel <id>           Cancel a running run
  runs resume <id>           Resume a failed run from its salvage branch [--instruction "..."]
  runs diff <id>             Print a run's unified diff
  runs artifacts <id>        Print a run's step artifacts (JSON)
  runs manifest <id>         Print a run's flight-recorder manifest (JSON)
  runs outcome <id> <ok|not_ok|clear>  Record your verdict on a finished run [--message "..."]
  workflows list             List available workflows
  repos list                 List targetable repositories
  issues list <owner/repo>   List a repo's open issues
  sources [--all]            Show work-item sources you can open a PR from (only connected, or --all)
  connectors status          Show connector status (github, notion, jira, linear, slack, gitlab, bitbucket)
  connectors connect <p>     Begin connecting a provider (prints the authorize URL)
  connectors disconnect <p>  Drop a provider's stored connection
  model status               Show active provider/model and key status
  model set <p> <m>          Save a model key from env/stdin and activate provider/model
  model use <p> <m>          Activate provider/model without changing the stored key

Global flags:
  --server <url>   Orchestrator base URL (else env/config/public API)
  --json           Print raw JSON instead of formatted output

Model key input:
  ANCHORAGE_MODEL_API_KEY=... anchorage model set <provider> <model>
  printf '%s' "$KEY" | anchorage model set <provider> <model>
`;

// ── output helpers ───────────────────────────────────────────────────────────

function out(value: unknown, json: boolean, format: () => string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${format()}\n`);
}

function runLine(r: RunSummary): string {
  const repo = `${r.owner}/${r.repo}`;
  const step = r.currentStep ? ` @${r.currentStep}` : "";
  const gate = r.awaitingApproval ? " (awaiting approval)" : "";
  const issue = r.issue ? ` #${r.issue}` : "";
  return `${r.id}  ${r.status.padEnd(9)} ${repo} ${r.workflow}${issue}${step}${gate}`;
}

function sourceLine(s: SourceSummary): string {
  const head = `${s.id.padEnd(10)} ${s.connected ? "connected" : "not connected"}`;
  if (s.connected) {
    const pr = s.prReady ? "" : ` (connect ${s.prTarget} to open the PR)`;
    return `${head} → ${s.workflow}${pr}`;
  }
  return `${head}${s.connectUrl ? `\n           connect: ${s.connectUrl}` : ""}`;
}

function connectorLine(id: string, s: ConnectorStatus & { connect_url?: string }): string {
  if (!s.available) return `${id.padEnd(10)} unavailable`;
  if (s.connected) {
    const who = s.login ? ` · ${s.login}` : "";
    const src = s.source ? ` [${s.source}${s.kind ? `:${s.kind}` : ""}]` : "";
    return `${id.padEnd(10)} connected${who}${src}`;
  }
  return `${id.padEnd(10)} not connected`;
}

function modelLine(llm: LlmStatus | null | undefined): string {
  if (!llm?.provider) return "No model configured.";
  const model = llm.model ? ` ${llm.model}` : "";
  const key = llm.hasKey ? "key registered" : "no key registered";
  return `${llm.provider}${model} (${key})`;
}

/** Read a secret for `auth login` from env, or from stdin when piped. Never a flag. */
async function readLoginSecret(): Promise<string | undefined> {
  const fromEnv =
    process.env.ANCHORAGE_ORCHESTRATOR_SECRET?.trim() || process.env.ORCHESTRATOR_SECRET?.trim();
  if (fromEnv) return fromEnv;
  if (process.stdin.isTTY) return undefined; // interactive: skip (server may be open)
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const piped = Buffer.concat(chunks).toString("utf8").trim();
  return piped || undefined;
}

/** Read a model API key from env, or stdin when piped. Never a CLI flag. */
async function readModelApiKey(provider: string): Promise<string | undefined> {
  const providerEnv = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  const fromEnv =
    process.env.ANCHORAGE_MODEL_API_KEY?.trim() ||
    process.env.ANCHORAGE_LLM_API_KEY?.trim() ||
    process.env[providerEnv]?.trim();
  if (fromEnv) return fromEnv;
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const piped = Buffer.concat(chunks).toString("utf8").trim();
  return piped || undefined;
}

function modelArgs(flags: Args["flags"], rest: string[]): { provider?: string; model?: string } {
  return {
    provider: str(flags, "provider") ?? rest[0],
    model: str(flags, "model") ?? rest[1],
  };
}

// ── command dispatch ─────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const json = flags.json === true;
  const [command, sub, ...rest] = positional;

  if (flags.version === true || command === "version") {
    process.stdout.write(`anchorage ${CLI_VERSION}\n`);
    return 0;
  }

  if (!command || flags.help === true) {
    process.stdout.write(USAGE);
    return flags.help === true ? 0 : 2;
  }

  const client = new OrchestratorClient(loadConfig(str(flags, "server")));

  switch (`${command} ${sub ?? ""}`.trim()) {
    case "auth login": {
      const secret = await readLoginSecret();
      const file = saveConfig({ serverUrl: client.serverUrl, ...(secret ? { secret } : {}) });
      out(
        { saved: file, serverUrl: client.serverUrl, secret: secret ? "stored" : "none" },
        json,
        () => `Saved ${client.serverUrl} to ${file}${secret ? " (with secret)" : " (no secret)"}`,
      );
      return 0;
    }
    case "auth whoami": {
      const who = await client.whoami();
      out(who, json, () =>
        who.kind === "admin" ? "admin" : `client ${who.clientId} (${who.name})`,
      );
      return 0;
    }
    case "auth token": {
      const { token } = await client.rotateToken();
      out({ token }, json, () => `New API token (shown once, previous invalidated):\n${token}`);
      return 0;
    }
    case "runs list": {
      const runs = await client.listRuns();
      out(runs, json, () => (runs.length ? runs.map(runLine).join("\n") : "No runs."));
      return 0;
    }
    case "runs start": {
      const repo = str(flags, "repo");
      const [owner, name] = repo?.split("/") ?? [];
      if (!owner || !name) {
        process.stderr.write("runs start requires --repo <owner/name>\n");
        return 2;
      }
      const issue = str(flags, "issue");
      const instruction = str(flags, "instruction");
      const run = await client.triggerRun({
        owner,
        repo: name,
        ...(issue ? { issue: Number(issue) } : {}),
        ...(instruction ? { instruction } : {}),
        ...(str(flags, "notion-page") ? { notionPage: str(flags, "notion-page") } : {}),
        ...(str(flags, "jira-issue") ? { jiraIssue: str(flags, "jira-issue") } : {}),
        ...(str(flags, "linear-issue") ? { linearIssue: str(flags, "linear-issue") } : {}),
        ...(str(flags, "gitlab-issue") ? { gitlabIssue: str(flags, "gitlab-issue") } : {}),
        ...(str(flags, "bitbucket-issue") ? { bitbucketIssue: str(flags, "bitbucket-issue") } : {}),
        ...(str(flags, "workflow") ? { pipeline: str(flags, "workflow") } : {}),
        ...(str(flags, "branch") ? { branch: str(flags, "branch") } : {}),
        ...(str(flags, "llm-provider") ? { llmProvider: str(flags, "llm-provider") } : {}),
        ...(str(flags, "llm-model") ? { llmModel: str(flags, "llm-model") } : {}),
      });
      out(run, json, () => `Started ${run.id}\n${runLine(run)}`);
      return 0;
    }
    case "runs review": {
      const repo = str(flags, "repo");
      const [owner, name] = repo?.split("/") ?? [];
      if (!owner || !name) return usageErr("runs review <pr-number> --repo <owner/name>");
      const prNumber = Number(rest[0]);
      if (!Number.isInteger(prNumber) || prNumber <= 0) {
        return usageErr("runs review <pr-number> --repo <owner/name>");
      }
      const run = await client.triggerRun({
        owner,
        repo: name,
        prNumber,
        pipeline: "review-pr",
        ...(str(flags, "llm-provider") ? { llmProvider: str(flags, "llm-provider") } : {}),
        ...(str(flags, "llm-model") ? { llmModel: str(flags, "llm-model") } : {}),
      });
      out(run, json, () => `Started ${run.id}\n${runLine(run)}`);
      return 0;
    }
    case "runs status": {
      const id = rest[0];
      if (!id) return usageErr("runs status <id>");
      const run = await client.getRun(id);
      out(run, json, () => runLine(run));
      return 0;
    }
    case "runs watch": {
      const id = rest[0];
      if (!id) return usageErr("runs watch <id>");
      process.stderr.write(`Watching ${id} (Ctrl-C to stop)…\n`);
      await client.streamEvents(id, (e) => {
        process.stdout.write(`${e.type.padEnd(18)} ${e.message}\n`);
      });
      const final = await client.getRun(id).catch(() => null);
      if (final) process.stderr.write(`\n${runLine(final)}\n`);
      return 0;
    }
    case "runs approve":
    case "runs reject": {
      const id = rest[0];
      if (!id) return usageErr(`runs ${sub} <id>`);
      await client.decideRun(id, sub === "approve");
      out(
        { id, decision: sub },
        json,
        () => `${sub === "approve" ? "Approved" : "Rejected"} ${id}`,
      );
      return 0;
    }
    case "runs cancel": {
      const id = rest[0];
      if (!id) return usageErr("runs cancel <id>");
      await client.cancelRun(id);
      out({ id, canceled: true }, json, () => `Canceled ${id}`);
      return 0;
    }
    case "runs resume": {
      const id = rest[0];
      if (!id) return usageErr('runs resume <id> [--instruction "..."]');
      const run = await client.resumeRun(id, str(flags, "instruction"));
      out(run, json, () => `Resumed ${id} → ${run.id}\n${runLine(run)}`);
      return 0;
    }
    case "runs diff": {
      const id = rest[0];
      if (!id) return usageErr("runs diff <id>");
      const d = await client.getRunDiff(id);
      out(d, json, () => d.diff ?? "(no diff)");
      return 0;
    }
    case "runs artifacts": {
      const id = rest[0];
      if (!id) return usageErr("runs artifacts <id>");
      const a = await client.getRunArtifacts(id);
      out(a, json, () => JSON.stringify(a, null, 2));
      return 0;
    }
    case "runs manifest": {
      const id = rest[0];
      if (!id) return usageErr("runs manifest <id>");
      const m = await client.getRunManifest(id);
      out(m, json, () => JSON.stringify(m, null, 2));
      return 0;
    }
    case "runs outcome": {
      const id = rest[0];
      const outcome = rest[1] ?? "";
      if (!id || !["ok", "not_ok", "clear"].includes(outcome)) {
        return usageErr('runs outcome <id> <ok|not_ok|clear> [--message "..."]');
      }
      const r = await client.setOutcome(id, outcome, str(flags, "message"));
      out(r, json, () => `Recorded outcome '${outcome}' on ${id}`);
      return 0;
    }
    case "workflows list": {
      const wfs = await client.listWorkflows();
      out(wfs, json, () => wfs.map((w) => `${w.name}\n  ${w.steps.join(" → ")}`).join("\n"));
      return 0;
    }
    case "repos list": {
      const repos = await client.listRepos();
      out(repos, json, () => (repos.length ? repos.join("\n") : "No repos."));
      return 0;
    }
    case "issues list": {
      const ownerRepo = rest[0];
      if (!ownerRepo?.includes("/")) return usageErr("issues list <owner/repo>");
      const issues = await client.listIssues(ownerRepo);
      out(issues, json, () =>
        issues.length
          ? issues.map((i) => `#${i.number}  ${i.title}`).join("\n")
          : "No open issues.",
      );
      return 0;
    }
    case "sources": {
      // Default to only-connected (the suggestion list); --all shows every source.
      const showAll = flags.all === true || flags.all === "true";
      const { sources } = await client.getSources(!showAll);
      out(sources, json, () =>
        sources.length
          ? sources.map(sourceLine).join("\n")
          : "No connected sources. Connect one with: anchorage connectors connect <provider>",
      );
      return 0;
    }
    case "connectors status": {
      const status = await client.getConnectors();
      out(status, json, () =>
        Object.entries(status)
          .map(([id, s]) => connectorLine(id, s))
          .join("\n"),
      );
      return 0;
    }
    case "connectors connect": {
      const provider = rest[0];
      if (!provider)
        return usageErr("connectors connect <github|notion|jira|linear|slack|gitlab|bitbucket>");
      const { authorizeUrl } = await client.startConnect(provider);
      out(
        { provider, authorizeUrl },
        json,
        () => `Open this URL in a browser to connect ${provider}:\n\n  ${authorizeUrl}\n`,
      );
      return 0;
    }
    case "connectors disconnect": {
      const provider = rest[0];
      if (!provider)
        return usageErr("connectors disconnect <github|notion|jira|linear|slack|gitlab|bitbucket>");
      const r = await client.disconnect(provider);
      out(r, json, () => `Disconnected ${provider} (removed ${r.removed}).`);
      return 0;
    }
    case "model status": {
      const me = await client.getMe();
      out(me, json, () => (me.kind === "client" ? modelLine(me.llm) : "admin (no client model)"));
      return 0;
    }
    case "model set": {
      const { provider, model } = modelArgs(flags, rest);
      if (!provider || !model) return usageErr("model set <provider> <model>");
      const apiKey = await readModelApiKey(provider);
      if (!apiKey) {
        process.stderr.write(
          "model set requires an API key via ANCHORAGE_MODEL_API_KEY, ANCHORAGE_LLM_API_KEY, provider env, or stdin\n",
        );
        return 2;
      }
      const llm = await client.setModel(provider, model, apiKey);
      out(llm, json, () => `Saved ${modelLine(llm)}.`);
      return 0;
    }
    case "model use": {
      const { provider, model } = modelArgs(flags, rest);
      if (!provider || !model) return usageErr("model use <provider> <model>");
      const llm = await client.setModel(provider, model);
      out(llm, json, () => `Activated ${modelLine(llm)}.`);
      return 0;
    }
    default:
      process.stderr.write(`Unknown command: ${command} ${sub ?? ""}\n\n${USAGE}`);
      return 2;
  }
}

function usageErr(usage: string): number {
  process.stderr.write(`Usage: anchorage ${usage}\n`);
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
