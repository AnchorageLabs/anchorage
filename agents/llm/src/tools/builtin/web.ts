import { checkWebBudget, recordWeb } from "../budget.js";
import type {
  JsonObject,
  JsonValue,
  ToolContext,
  ToolDefinition,
  ToolHandlerResult,
} from "../types.js";

const MAX_FETCH_BYTES = 1_000_000;
const MAX_FETCH_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;

const ALLOWED_CONTENT_TYPES = [
  "text/",
  "application/json",
  "application/xhtml",
  "application/xml",
  "application/ld+json",
  "application/atom+xml",
  "application/rss+xml",
];

// ── Common HTTP helper with timeout + size cap ─────────────────────────────

interface HttpOpts {
  headers?: Record<string, string>;
  timeoutMs?: number;
  redirectsLeft?: number;
}

interface HttpResult {
  ok: true;
  status: number;
  url: string;
  contentType: string;
  body: string;
  bytes: number;
}

async function httpGet(
  url: string,
  opts: HttpOpts = {},
): Promise<HttpResult | { ok: false; message: string }> {
  if (!/^https:\/\//i.test(url)) {
    return { ok: false, message: `Only https:// URLs are allowed (got ${url}).` };
  }
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const redirectsLeft = opts.redirectsLeft ?? MAX_FETCH_REDIRECTS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "user-agent": "anchorage-agent/0.1", ...(opts.headers ?? {}) },
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  clearTimeout(timer);

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const next = response.headers.get("location");
    if (!next) return { ok: false, message: `redirect ${response.status} without location header` };
    if (redirectsLeft <= 0) return { ok: false, message: "too many redirects" };
    const absolute = new URL(next, url).toString();
    return httpGet(absolute, { ...opts, redirectsLeft: redirectsLeft - 1 });
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.some((prefix) => contentType.startsWith(prefix))) {
    return {
      ok: false,
      message: `Refusing content-type '${contentType || "unknown"}'.`,
    };
  }

  let body = "";
  let bytes = 0;
  const reader = response.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    while (bytes < MAX_FETCH_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const remaining = MAX_FETCH_BYTES - bytes;
        const chunk = value.byteLength <= remaining ? value : value.subarray(0, remaining);
        body += decoder.decode(chunk, { stream: chunk.byteLength === value.byteLength });
        bytes += chunk.byteLength;
        if (chunk.byteLength < value.byteLength) {
          body += "\n…[truncated]";
          break;
        }
      }
    }
    body += decoder.decode();
  } else {
    body = await response.text();
    bytes = Buffer.byteLength(body, "utf8");
    if (bytes > MAX_FETCH_BYTES) {
      body = `${body.slice(0, MAX_FETCH_BYTES)}\n…[truncated]`;
      bytes = MAX_FETCH_BYTES;
    }
  }

  return {
    ok: true,
    status: response.status,
    url,
    contentType,
    body,
    bytes,
  };
}

// ── web_search ──────────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function webSearchHandler(input: JsonObject, ctx: ToolContext): Promise<ToolHandlerResult> {
  const budgetCheck = checkWebBudget(ctx.budget);
  if (!budgetCheck.ok) {
    return {
      ok: false,
      code: "budget_exceeded",
      message: budgetCheck.message ?? "Web budget exceeded.",
    };
  }

  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) {
    return { ok: false, code: "invalid_input", message: "web_search requires a 'query' string." };
  }
  const maxResults =
    typeof input.max_results === "number" && input.max_results > 0
      ? Math.min(Math.floor(input.max_results), 10)
      : 5;

  const provider = pickSearchProvider(ctx.env);
  let results: SearchResult[];
  switch (provider.kind) {
    case "tavily":
      results = await tavilySearch(provider.apiKey, query, maxResults);
      break;
    case "brave":
      results = await braveSearch(provider.apiKey, query, maxResults);
      break;
    case "duckduckgo":
      results = await duckDuckGoSearch(query, maxResults);
      break;
  }

  recordWeb(ctx.budget, JSON.stringify(results).length);

  if (results.length === 0) {
    return {
      ok: true,
      output: `=== web_search (${provider.kind}): "${query}" ===\n(no results)`,
      bytesOut: 80,
      meta: { provider: provider.kind, query, results: 0 },
    };
  }

  const lines = [`=== web_search (${provider.kind}): "${query}" ===`];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
  });
  const text = lines.join("\n");

  return {
    ok: true,
    output: text,
    bytesOut: text.length,
    meta: { provider: provider.kind, query, results: results.length },
  };
}

type SearchProvider =
  | { kind: "tavily"; apiKey: string }
  | { kind: "brave"; apiKey: string }
  | { kind: "duckduckgo" };

function pickSearchProvider(env: Record<string, string>): SearchProvider {
  const explicit = env.ANCHORAGE_WEB_SEARCH_PROVIDER;
  if (explicit === "tavily" && env.TAVILY_API_KEY) {
    return { kind: "tavily", apiKey: env.TAVILY_API_KEY };
  }
  if (explicit === "brave" && env.BRAVE_SEARCH_API_KEY) {
    return { kind: "brave", apiKey: env.BRAVE_SEARCH_API_KEY };
  }
  if (env.TAVILY_API_KEY) return { kind: "tavily", apiKey: env.TAVILY_API_KEY };
  if (env.BRAVE_SEARCH_API_KEY) return { kind: "brave", apiKey: env.BRAVE_SEARCH_API_KEY };
  return { kind: "duckduckgo" };
}

async function tavilySearch(
  apiKey: string,
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        search_depth: "basic",
      }),
    });
    if (!response.ok) return [];
    const parsed = (await response.json()) as JsonObject;
    const raw = Array.isArray(parsed.results) ? parsed.results : [];
    return raw
      .map(toSearchResult)
      .filter((entry): entry is SearchResult => entry !== null)
      .slice(0, maxResults);
  } catch {
    return [];
  }
}

async function braveSearch(
  apiKey: string,
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  try {
    const u = new URL("https://api.search.brave.com/res/v1/web/search");
    u.searchParams.set("q", query);
    u.searchParams.set("count", String(maxResults));
    const response = await fetch(u, {
      headers: { "x-subscription-token": apiKey, accept: "application/json" },
    });
    if (!response.ok) return [];
    const parsed = (await response.json()) as JsonObject;
    const web = parsed.web as JsonObject | undefined;
    const raw = Array.isArray(web?.results) ? (web.results as JsonValue[]) : [];
    return raw
      .map(toSearchResult)
      .filter((entry): entry is SearchResult => entry !== null)
      .slice(0, maxResults);
  } catch {
    return [];
  }
}

async function duckDuckGoSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    const u = new URL("https://html.duckduckgo.com/html/");
    u.searchParams.set("q", query);
    const response = await fetch(u, {
      headers: { "user-agent": "anchorage-agent/0.1" },
    });
    if (!response.ok) return [];
    const html = await response.text();
    return parseDuckDuckGoHtml(html, maxResults);
  } catch {
    return [];
  }
}

function parseDuckDuckGoHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const titles: { url: string; title: string }[] = [];
  let match: RegExpExecArray | null = resultRegex.exec(html);
  while (match !== null && titles.length < maxResults * 2) {
    const rawUrl = decodeDdgRedirect(match[1] ?? "");
    if (rawUrl) titles.push({ url: rawUrl, title: stripTags(match[2] ?? "").trim() });
    match = resultRegex.exec(html);
  }
  const snippets: string[] = [];
  match = snippetRegex.exec(html);
  while (match !== null && snippets.length < titles.length) {
    snippets.push(stripTags(match[1] ?? "").trim());
    match = snippetRegex.exec(html);
  }
  for (let i = 0; i < titles.length && results.length < maxResults; i++) {
    const entry = titles[i];
    if (!entry) continue;
    results.push({ url: entry.url, title: entry.title, snippet: snippets[i] ?? "" });
  }
  return results;
}

function decodeDdgRedirect(href: string): string {
  // DuckDuckGo wraps results in /l/?uddg=<encoded>. Unwrap when present.
  try {
    if (href.startsWith("//")) href = `https:${href}`;
    if (href.startsWith("/")) href = `https://duckduckgo.com${href}`;
    const u = new URL(href);
    const uddg = u.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : u.toString();
  } catch {
    return "";
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function toSearchResult(raw: JsonValue): SearchResult | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as JsonObject;
  const url = typeof obj.url === "string" ? obj.url : typeof obj.link === "string" ? obj.link : "";
  const title = typeof obj.title === "string" ? obj.title : "";
  const snippet =
    typeof obj.content === "string"
      ? obj.content
      : typeof obj.description === "string"
        ? obj.description
        : typeof obj.snippet === "string"
          ? obj.snippet
          : "";
  if (!url || !title) return null;
  return { url, title, snippet: snippet.slice(0, 400) };
}

export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description:
    "Search the open web. Provider order: Tavily (TAVILY_API_KEY) → Brave (BRAVE_SEARCH_API_KEY) → " +
    "DuckDuckGo HTML scrape (no key). Returns up to 10 results: title, URL, snippet. " +
    "Use this for library docs, error messages, framework changes, related public issues.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", minLength: 1 },
      max_results: { type: "integer", minimum: 1, maximum: 10 },
    },
  },
  capability: "web.read",
  handler: webSearchHandler,
};

// ── web_fetch ───────────────────────────────────────────────────────────────

async function webFetchHandler(input: JsonObject, ctx: ToolContext): Promise<ToolHandlerResult> {
  const budgetCheck = checkWebBudget(ctx.budget);
  if (!budgetCheck.ok) {
    return {
      ok: false,
      code: "budget_exceeded",
      message: budgetCheck.message ?? "Web budget exceeded.",
    };
  }
  const url = typeof input.url === "string" ? input.url : "";
  if (!url) {
    return { ok: false, code: "invalid_input", message: "web_fetch requires a 'url' string." };
  }

  const result = await httpGet(url);
  if (!result.ok) {
    return { ok: false, code: "fetch_failed", message: result.message };
  }
  recordWeb(ctx.budget, result.bytes);

  return {
    ok: true,
    output: `=== web_fetch ${result.url} (status ${result.status}, ${result.contentType}) ===\n${result.body}`,
    bytesOut: result.bytes,
    meta: {
      url: result.url,
      status: result.status,
      contentType: result.contentType,
      bytes: result.bytes,
    },
  };
}

export const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  description:
    "Fetch a single HTTPS URL. Content-type must be text/json/xml. 1 MB cap, 5 redirect cap, " +
    "15s timeout. Use after web_search when a specific page is worth reading in full.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string", description: "Absolute HTTPS URL." },
    },
  },
  capability: "web.read",
  handler: webFetchHandler,
};

// ── github_search_issues ────────────────────────────────────────────────────

async function githubSearchIssuesHandler(
  input: JsonObject,
  ctx: ToolContext,
): Promise<ToolHandlerResult> {
  const budgetCheck = checkWebBudget(ctx.budget);
  if (!budgetCheck.ok) {
    return {
      ok: false,
      code: "budget_exceeded",
      message: budgetCheck.message ?? "Web budget exceeded.",
    };
  }
  const owner = typeof input.owner === "string" ? input.owner : "";
  const repo = typeof input.repo === "string" ? input.repo : "";
  const query = typeof input.query === "string" ? input.query : "";
  if (!owner || !repo || !query) {
    return {
      ok: false,
      code: "invalid_input",
      message: "github_search_issues requires owner, repo, and query.",
    };
  }

  const q = encodeURIComponent(`${query} repo:${owner}/${repo}`);
  const token = ctx.env.GH_TOKEN || ctx.env.GITHUB_TOKEN;
  const result = await httpGet(`https://api.github.com/search/issues?q=${q}&per_page=10`, {
    headers: token
      ? { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }
      : { accept: "application/vnd.github+json" },
  });
  if (!result.ok) {
    return { ok: false, code: "github_search_failed", message: result.message };
  }
  recordWeb(ctx.budget, result.bytes);

  let parsed: JsonObject;
  try {
    parsed = JSON.parse(result.body) as JsonObject;
  } catch (error) {
    return {
      ok: false,
      code: "github_search_invalid_json",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const items = Array.isArray(parsed.items) ? (parsed.items as JsonObject[]) : [];
  if (items.length === 0) {
    return {
      ok: true,
      output: `=== github_search_issues ${owner}/${repo} "${query}" ===\n(no matches)`,
      bytesOut: 60,
      meta: { owner, repo, query, results: 0 },
    };
  }
  const lines = [`=== github_search_issues ${owner}/${repo} "${query}" ===`];
  for (const item of items.slice(0, 10)) {
    const num = item.number;
    const state = item.state;
    const title = typeof item.title === "string" ? item.title : "(no title)";
    const isPr = item.pull_request !== undefined;
    lines.push(`#${num} [${state}${isPr ? "/pr" : ""}] ${title}`);
    if (typeof item.html_url === "string") lines.push(`  ${item.html_url}`);
  }
  const text = lines.join("\n");
  return {
    ok: true,
    output: text,
    bytesOut: text.length,
    meta: { owner, repo, query, results: items.length },
  };
}

export const githubSearchIssuesTool: ToolDefinition = {
  name: "github_search_issues",
  description:
    "Search issues + PRs in a GitHub repo using the same syntax as GitHub's UI. " +
    "Uses GH_TOKEN if present (60→5000 req/h). Returns up to 10 matches.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["owner", "repo", "query"],
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      query: { type: "string", description: "GitHub search syntax, e.g. 'auth bug is:closed'." },
    },
  },
  capability: "web.read",
  handler: githubSearchIssuesHandler,
};

// ── github_get_file ─────────────────────────────────────────────────────────

async function githubGetFileHandler(
  input: JsonObject,
  ctx: ToolContext,
): Promise<ToolHandlerResult> {
  const budgetCheck = checkWebBudget(ctx.budget);
  if (!budgetCheck.ok) {
    return {
      ok: false,
      code: "budget_exceeded",
      message: budgetCheck.message ?? "Web budget exceeded.",
    };
  }
  const owner = typeof input.owner === "string" ? input.owner : "";
  const repo = typeof input.repo === "string" ? input.repo : "";
  const filePath = typeof input.path === "string" ? input.path : "";
  const ref = typeof input.ref === "string" ? input.ref : "";
  if (!owner || !repo || !filePath) {
    return {
      ok: false,
      code: "invalid_input",
      message: "github_get_file requires owner, repo, and path.",
    };
  }
  const safePath = filePath.replace(/^\/+/, "");
  if (safePath.includes("..")) {
    return { ok: false, code: "invalid_input", message: "path may not contain '..'." };
  }

  const u = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${safePath.split("/").map(encodeURIComponent).join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
  const token = ctx.env.GH_TOKEN || ctx.env.GITHUB_TOKEN;
  const result = await httpGet(u, {
    headers: token
      ? { authorization: `Bearer ${token}`, accept: "application/vnd.github.raw" }
      : { accept: "application/vnd.github.raw" },
  });
  if (!result.ok) {
    return { ok: false, code: "github_get_file_failed", message: result.message };
  }
  recordWeb(ctx.budget, result.bytes);

  return {
    ok: true,
    output: `=== github_get_file ${owner}/${repo}:${safePath}${ref ? `@${ref}` : ""} ===\n${result.body}`,
    bytesOut: result.bytes,
    meta: { owner, repo, path: safePath, ref: ref || null, bytes: result.bytes },
  };
}

export const githubGetFileTool: ToolDefinition = {
  name: "github_get_file",
  description:
    "Fetch a single file's raw contents from a GitHub repository. Useful for reading files " +
    "in repos other than the active workspace (e.g. a dependency or a sibling repo). " +
    "Uses GH_TOKEN if present. 1 MB cap.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["owner", "repo", "path"],
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      path: { type: "string", description: "Path within the repo." },
      ref: { type: "string", description: "Optional branch/tag/sha." },
    },
  },
  capability: "web.read",
  handler: githubGetFileHandler,
};

export const webTools: ToolDefinition[] = [
  webSearchTool,
  webFetchTool,
  githubSearchIssuesTool,
  githubGetFileTool,
];
