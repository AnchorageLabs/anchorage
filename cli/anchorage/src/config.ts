import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface CliConfig {
  /** Orchestrator base URL, e.g. https://api.anchoragelabs.dev */
  serverUrl: string;
  /** ORCHESTRATOR_SECRET or a per-client API token, when auth is enabled. */
  secret?: string;
}

const CONFIG_DIR = path.join(homedir(), ".config", "anchoragelabs");
const CONFIG_FILE = path.join(CONFIG_DIR, "cli.json");
export const DEFAULT_SERVER_URL = "https://api.anchoragelabs.dev";

function readConfigFile(): Partial<CliConfig> {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Record<string, unknown>;
    return {
      ...(typeof raw.serverUrl === "string" ? { serverUrl: raw.serverUrl } : {}),
      ...(typeof raw.secret === "string" ? { secret: raw.secret } : {}),
    };
  } catch {
    return {}; // missing/invalid file → fall back to env/defaults
  }
}

/**
 * Resolve the CLI config. Precedence: --server flag > env
 * (ANCHORAGE_ORCHESTRATOR_URL > ORCHESTRATOR_URL) > ~/.config/anchoragelabs/cli.json
 * > public API default. The secret is never read from a flag (shell history) —
 * env, the config file, or `anchorage auth login` only.
 */
export function loadConfig(serverFlag?: string): CliConfig {
  const file = readConfigFile();
  const serverUrl = (
    serverFlag ??
    process.env.ANCHORAGE_ORCHESTRATOR_URL ??
    process.env.ORCHESTRATOR_URL ??
    file.serverUrl ??
    DEFAULT_SERVER_URL
  ).replace(/\/+$/, "");
  const secret =
    process.env.ANCHORAGE_ORCHESTRATOR_SECRET?.trim() ||
    process.env.ORCHESTRATOR_SECRET?.trim() ||
    file.secret;
  return { serverUrl, ...(secret ? { secret } : {}) };
}

/** Persist server URL (+ optional secret) to the config file for later commands. */
export function saveConfig(config: CliConfig): string {
  mkdirSync(CONFIG_DIR, { recursive: true });
  // 0600: the file may hold a bearer secret.
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return CONFIG_FILE;
}

export const CONFIG_FILE_PATH = CONFIG_FILE;
