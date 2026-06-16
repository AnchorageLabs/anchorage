// Notion tools for the agent tool-loop. These give an LLM agent real "hands"
// over a Notion workspace: search, read pages/databases, and mutate them
// (create pages, append/update/delete blocks, edit properties, manage
// databases, post comments). The capability field gates each tool against the
// run's task.capabilities[] — read tools require "notion.read", write tools
// require "notion.write" — so a run that was only granted read access never
// sees the mutating tools in the catalog.
//
// All operations are bounded by the Notion integration token: the agent can
// only touch pages and databases that have been explicitly shared with the
// connector. That share boundary is the security perimeter, not this code.

import type {
  JsonObject,
  JsonValue,
  ToolContext,
  ToolDefinition,
  ToolHandlerResult,
} from "../types.js";

// Notion caps a single rich_text text object at 2000 characters.
const NOTION_TEXT_CHUNK = 2000;
const NOTION_PAGE_SIZE = 100;

// ── HTTP client ───────────────────────────────────────────────────────────────

interface NotionAuth {
  token: string;
  base: string;
  version: string;
}

function resolveAuth(ctx: ToolContext): NotionAuth | { error: string } {
  const token = ctx.env.NOTION_TOKEN || ctx.env.NOTION_API_KEY;
  if (!token) {
    return { error: "Set NOTION_TOKEN or NOTION_API_KEY to call the Notion API." };
  }
  return {
    token,
    base: ctx.env.NOTION_API_BASE_URL ?? "https://api.notion.com",
    version: ctx.env.NOTION_VERSION ?? "2022-06-28",
  };
}

async function notionRequest(
  auth: NotionAuth,
  method: "DELETE" | "GET" | "PATCH" | "POST",
  requestPath: string,
  body?: JsonObject,
): Promise<JsonObject> {
  const response = await fetch(`${auth.base}${requestPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "Notion-Version": auth.version,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await response.json().catch(() => null)) as JsonValue | null;
  if (!response.ok) {
    const apiMessage = isObject(data) ? readString(data.message) : null;
    throw new Error(
      `Notion API ${response.status} on ${method} ${requestPath}: ${apiMessage ?? "request failed"}`,
    );
  }
  if (!isObject(data))
    throw new Error(`Notion API returned a non-object response on ${requestPath}`);
  return data;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: JsonValue | undefined): null | string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Accepts a raw 32-hex id, a dashed UUID, or a Notion URL; returns the dashed form. */
function normalizeId(value: JsonValue | undefined): null | string {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const candidate = value.trim();
  const fromUrl = candidate.includes("notion.so")
    ? (candidate
        .split("?")[0]
        ?.match(/[0-9a-f]{32}(?![0-9a-f])/gi)
        ?.at(-1) ?? null)
    : null;
  const raw = (fromUrl ?? candidate).replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(raw)) return null;
  const hex = raw.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function toRichText(content: string): Array<{ text: { content: string } }> {
  const chunks: Array<{ text: { content: string } }> = [];
  const text = content.length === 0 ? "" : content;
  if (text.length === 0) return [{ text: { content: "" } }];
  for (let offset = 0; offset < text.length; offset += NOTION_TEXT_CHUNK) {
    chunks.push({ text: { content: text.slice(offset, offset + NOTION_TEXT_CHUNK) } });
  }
  return chunks;
}

function richTextToPlain(value: JsonValue | undefined): string {
  if (!Array.isArray(value)) return "";
  return value.map((item) => (isObject(item) ? (readString(item.plain_text) ?? "") : "")).join("");
}

/**
 * Converts a small, common subset of Markdown into Notion block objects so the
 * model can write notes/wikis without hand-authoring Notion's block JSON. The
 * inverse of the notion-reader's renderBlock. Unhandled syntax degrades to
 * paragraphs.
 */
function markdownToBlocks(markdown: string): JsonObject[] {
  const blocks: JsonObject[] = [];
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^```(\w*)$/);
    if (fence) {
      const language = fence[1] || "plain text";
      const code: string[] = [];
      index += 1;
      while (index < lines.length && (lines[index] ?? "").trim() !== "```") {
        code.push(lines[index] ?? "");
        index += 1;
      }
      index += 1; // skip closing fence
      blocks.push({
        object: "block",
        type: "code",
        code: { rich_text: toRichText(code.join("\n")), language },
      });
      continue;
    }

    blocks.push(lineToBlock(trimmed));
    index += 1;
  }
  return blocks;
}

function lineToBlock(line: string): JsonObject {
  const heading = line.match(/^(#{1,3})\s+(.*)$/);
  if (heading) {
    const level = heading[1]?.length ?? 1;
    const type = `heading_${level}`;
    return { object: "block", type, [type]: { rich_text: toRichText(heading[2] ?? "") } };
  }
  const todo = line.match(/^[-*]\s+\[( |x|X)\]\s+(.*)$/);
  if (todo) {
    return {
      object: "block",
      type: "to_do",
      to_do: {
        rich_text: toRichText(todo[2] ?? ""),
        checked: (todo[1] ?? "").toLowerCase() === "x",
      },
    };
  }
  const bullet = line.match(/^[-*]\s+(.*)$/);
  if (bullet) {
    return {
      object: "block",
      type: "bulleted_list_item",
      bulleted_list_item: { rich_text: toRichText(bullet[1] ?? "") },
    };
  }
  const numbered = line.match(/^\d+\.\s+(.*)$/);
  if (numbered) {
    return {
      object: "block",
      type: "numbered_list_item",
      numbered_list_item: { rich_text: toRichText(numbered[1] ?? "") },
    };
  }
  const quote = line.match(/^>\s+(.*)$/);
  if (quote) {
    return { object: "block", type: "quote", quote: { rich_text: toRichText(quote[1] ?? "") } };
  }
  if (line === "---") return { object: "block", type: "divider", divider: {} };
  return { object: "block", type: "paragraph", paragraph: { rich_text: toRichText(line) } };
}

/** Builds the children array for create/append from either raw blocks or markdown. */
function resolveChildren(
  input: JsonObject,
): { ok: true; value: JsonObject[] } | { ok: false; message: string } {
  if (Array.isArray(input.children)) {
    return { ok: true, value: input.children.filter(isObject) };
  }
  const markdown = readString(input.markdown);
  if (markdown) return { ok: true, value: markdownToBlocks(markdown) };
  return {
    ok: false,
    message: "Provide either a 'children' array of Notion blocks or a 'markdown' string.",
  };
}

function ok(output: string, meta?: JsonObject): ToolHandlerResult {
  return { ok: true, output, bytesOut: output.length, ...(meta ? { meta } : {}) };
}

function fail(code: string, message: string): ToolHandlerResult {
  return { ok: false, code, message };
}

async function withClient(
  ctx: ToolContext,
  run: (auth: NotionAuth) => Promise<ToolHandlerResult>,
): Promise<ToolHandlerResult> {
  const auth = resolveAuth(ctx);
  if ("error" in auth) return fail("missing_notion_token", auth.error);
  try {
    return await run(auth);
  } catch (error) {
    return fail("notion_request_failed", error instanceof Error ? error.message : String(error));
  }
}

function summarizePage(page: JsonObject): string {
  const properties = isObject(page.properties) ? page.properties : {};
  let title = "(untitled)";
  for (const property of Object.values(properties)) {
    if (isObject(property) && property.type === "title") {
      const value = richTextToPlain(property.title).trim();
      if (value) title = value;
      break;
    }
  }
  const url = readString(page.url) ?? "";
  return `${title}${url ? ` — ${url}` : ""} (id: ${readString(page.id) ?? "?"})`;
}

// ── Read tools ────────────────────────────────────────────────────────────────

const searchTool: ToolDefinition = {
  name: "notion_search",
  description:
    "Search the connected Notion workspace for pages and databases by title text. Returns matching ids, titles, and URLs. Use this to locate where to read or write before acting.",
  capability: "notion.read",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Text to match against page/database titles. Empty returns recently edited items.",
      },
      filter: {
        type: "string",
        enum: ["page", "database"],
        description: "Restrict results to pages or databases.",
      },
      page_size: { type: "number", description: "Max results (1-50, default 10)." },
    },
  },
  handler: (input, ctx) =>
    withClient(ctx, async (auth) => {
      const pageSize = Math.min(Math.max(Number(input.page_size) || 10, 1), 50);
      const body: JsonObject = { page_size: pageSize };
      const query = readString(input.query);
      if (query) body.query = query;
      const filter = readString(input.filter);
      if (filter === "page" || filter === "database") {
        body.filter = { property: "object", value: filter };
      }
      const data = await notionRequest(auth, "POST", "/v1/search", body);
      const results = Array.isArray(data.results) ? data.results : [];
      if (results.length === 0) return ok(`No Notion results for query: ${query ?? "(recent)"}`);
      const lines = results.filter(isObject).map((item) => {
        const object = readString(item.object) ?? "object";
        const label =
          object === "database"
            ? richTextToPlain(item.title).trim() || "(untitled database)"
            : summarizePage(item);
        return `- [${object}] ${object === "database" ? `${label} (id: ${readString(item.id)})` : label}`;
      });
      return ok(`=== notion_search: "${query ?? "(recent)"}" ===\n${lines.join("\n")}`, {
        count: results.length,
      });
    }),
};

const getPageTool: ToolDefinition = {
  name: "notion_get_page",
  description:
    "Retrieve a Notion page's properties (title, status, select, etc.) by page id or URL. Does NOT return body content — use notion_get_block_children for the page body.",
  capability: "notion.read",
  inputSchema: {
    type: "object",
    properties: {
      page_id: { type: "string", description: "Page id (32 hex, dashed or not) or Notion URL." },
    },
    required: ["page_id"],
  },
  handler: (input, ctx) =>
    withClient(ctx, async (auth) => {
      const pageId = normalizeId(input.page_id);
      if (!pageId) return fail("invalid_input", "notion_get_page requires a valid 'page_id'.");
      const page = await notionRequest(auth, "GET", `/v1/pages/${pageId}`);
      return ok(
        JSON.stringify({ id: pageId, properties: page.properties, url: page.url }, null, 2),
        {
          pageId,
        },
      );
    }),
};

const getBlockChildrenTool: ToolDefinition = {
  name: "notion_get_block_children",
  description:
    "List the child blocks of a page or block (its body content) as JSON. Pass a page id to read the page body. Paginates automatically up to a few hundred blocks.",
  capability: "notion.read",
  inputSchema: {
    type: "object",
    properties: { block_id: { type: "string", description: "Page or block id / URL." } },
    required: ["block_id"],
  },
  handler: (input, ctx) =>
    withClient(ctx, async (auth) => {
      const blockId = normalizeId(input.block_id);
      if (!blockId)
        return fail("invalid_input", "notion_get_block_children requires a valid 'block_id'.");
      const collected: JsonValue[] = [];
      let cursor: null | string = null;
      let pages = 0;
      do {
        const query = cursor
          ? `?page_size=${NOTION_PAGE_SIZE}&start_cursor=${cursor}`
          : `?page_size=${NOTION_PAGE_SIZE}`;
        const data: JsonObject = await notionRequest(
          auth,
          "GET",
          `/v1/blocks/${blockId}/children${query}`,
        );
        if (Array.isArray(data.results)) collected.push(...data.results);
        cursor = data.has_more === true ? readString(data.next_cursor) : null;
        pages += 1;
      } while (cursor && pages < 5);
      return ok(JSON.stringify(collected, null, 2), { count: collected.length });
    }),
};

const getDatabaseTool: ToolDefinition = {
  name: "notion_get_database",
  description: "Retrieve a Notion database's schema (its property definitions) by id or URL.",
  capability: "notion.read",
  inputSchema: {
    type: "object",
    properties: { database_id: { type: "string", description: "Database id / URL." } },
    required: ["database_id"],
  },
  handler: (input, ctx) =>
    withClient(ctx, async (auth) => {
      const databaseId = normalizeId(input.database_id);
      if (!databaseId)
        return fail("invalid_input", "notion_get_database requires a valid 'database_id'.");
      const db = await notionRequest(auth, "GET", `/v1/databases/${databaseId}`);
      return ok(
        JSON.stringify(
          { id: databaseId, title: richTextToPlain(db.title), properties: db.properties },
          null,
          2,
        ),
        { databaseId },
      );
    }),
};

const queryDatabaseTool: ToolDefinition = {
  name: "notion_query_database",
  description:
    "Query rows (pages) in a Notion database, optionally with a Notion filter and sorts object. Returns each row's id, title, and properties.",
  capability: "notion.read",
  inputSchema: {
    type: "object",
    properties: {
      database_id: { type: "string", description: "Database id / URL." },
      filter: { type: "object", description: "Optional Notion filter object (see Notion API)." },
      sorts: { type: "array", description: "Optional Notion sorts array." },
      page_size: { type: "number", description: "Max rows (1-100, default 25)." },
    },
    required: ["database_id"],
  },
  handler: (input, ctx) =>
    withClient(ctx, async (auth) => {
      const databaseId = normalizeId(input.database_id);
      if (!databaseId)
        return fail("invalid_input", "notion_query_database requires a valid 'database_id'.");
      const body: JsonObject = {
        page_size: Math.min(Math.max(Number(input.page_size) || 25, 1), 100),
      };
      if (isObject(input.filter)) body.filter = input.filter;
      if (Array.isArray(input.sorts)) body.sorts = input.sorts;
      const data = await notionRequest(auth, "POST", `/v1/databases/${databaseId}/query`, body);
      const rows = (Array.isArray(data.results) ? data.results : []).filter(isObject);
      const summary = rows.map((row) => ({ id: row.id, properties: row.properties, url: row.url }));
      return ok(JSON.stringify(summary, null, 2), { count: rows.length });
    }),
};

// ── Write tools ───────────────────────────────────────────────────────────────

const createPageTool: ToolDefinition = {
  name: "notion_create_page",
  description:
    "Create a new Notion page, either as a child of an existing page (parent_page_id) or as a row in a database (parent_database_id). Provide the title, optional Notion 'properties' (required keys depend on the database schema), and body content as 'markdown' or raw 'children' blocks.",
  capability: "notion.write",
  inputSchema: {
    type: "object",
    properties: {
      parent_page_id: {
        type: "string",
        description:
          "Parent page id/URL (for a sub-page). Mutually exclusive with parent_database_id.",
      },
      parent_database_id: {
        type: "string",
        description:
          "Parent database id/URL (to add a row). Mutually exclusive with parent_page_id.",
      },
      title: { type: "string", description: "Page title (used for the title property)." },
      properties: {
        type: "object",
        description:
          "Raw Notion properties object. For a database row, set the non-title properties here. Overrides title if it includes the title property.",
      },
      markdown: {
        type: "string",
        description: "Page body as simple markdown (headings, bullets, todos, code, quotes).",
      },
      children: {
        type: "array",
        description: "Raw Notion block objects for the body (instead of markdown).",
      },
    },
  },
  handler: (input, ctx) =>
    withClient(ctx, async (auth) => {
      const parentPage = normalizeId(input.parent_page_id);
      const parentDb = normalizeId(input.parent_database_id);
      if (!parentPage && !parentDb) {
        return fail("invalid_input", "Provide parent_page_id or parent_database_id.");
      }
      const parent: JsonObject = parentDb
        ? { database_id: parentDb }
        : { page_id: parentPage as string };

      const properties: JsonObject = isObject(input.properties) ? { ...input.properties } : {};
      const title = readString(input.title);
      if (title && !hasTitleProperty(properties)) {
        // Database rows need the title keyed by the schema's title column name; a
        // plain page accepts the reserved "title" key. Default to "title" and let
        // an explicit properties.title/Name override.
        properties.title = { title: toRichText(title) };
      }

      const body: JsonObject = { parent, properties };
      if (Array.isArray(input.children) || readString(input.markdown)) {
        const children = resolveChildren(input);
        if (!children.ok) return fail("invalid_input", children.message);
        body.children = children.value;
      }
      const page = await notionRequest(auth, "POST", "/v1/pages", body);
      return ok(`Created page: ${summarizePage(page)}`, {
        pageId: readString(page.id),
        url: readString(page.url),
      });
    }),
};

function hasTitleProperty(properties: JsonObject): boolean {
  return Object.values(properties).some((p) => isObject(p) && "title" in p);
}

const appendBlocksTool: ToolDefinition = {
  name: "notion_append_blocks",
  description:
    "Append content to the end of a page or block. Provide the body as 'markdown' (simple notes/wikis) or as raw Notion 'children' blocks for full control.",
  capability: "notion.write",
  inputSchema: {
    type: "object",
    properties: {
      block_id: { type: "string", description: "Page or block id/URL to append to." },
      markdown: { type: "string", description: "Content as simple markdown." },
      children: { type: "array", description: "Raw Notion block objects." },
    },
    required: ["block_id"],
  },
  handler: (input, ctx) =>
    withClient(ctx, async (auth) => {
      const blockId = normalizeId(input.block_id);
      if (!blockId)
        return fail("invalid_input", "notion_append_blocks requires a valid 'block_id'.");
      const children = resolveChildren(input);
      if (!children.ok) return fail("invalid_input", children.message);
      if (children.value.length === 0) return fail("invalid_input", "No blocks to append.");
      const data = await notionRequest(auth, "PATCH", `/v1/blocks/${blockId}/children`, {
        children: children.value,
      });
      const appended = Array.isArray(data.results) ? data.results.length : children.value.length;
      return ok(`Appended ${appended} block(s) to ${blockId}.`, { blockId, appended });
    }),
};

const updateBlockTool: ToolDefinition = {
  name: "notion_update_block",
  description:
    "Update a single existing block's content. Provide 'block' as the raw Notion block payload for its type (e.g. { paragraph: { rich_text: [...] } }).",
  capability: "notion.write",
  inputSchema: {
    type: "object",
    properties: {
      block_id: { type: "string", description: "Block id to update." },
      block: {
        type: "object",
        description: "Raw Notion block update payload keyed by block type.",
      },
    },
    required: ["block_id", "block"],
  },
  handler: (input, ctx) =>
    withClient(ctx, async (auth) => {
      const blockId = normalizeId(input.block_id);
      if (!blockId)
        return fail("invalid_input", "notion_update_block requires a valid 'block_id'.");
      if (!isObject(input.block))
        return fail("invalid_input", "notion_update_block requires a 'block' object.");
      await notionRequest(auth, "PATCH", `/v1/blocks/${blockId}`, input.block);
      return ok(`Updated block ${blockId}.`, { blockId });
    }),
};

const deleteBlockTool: ToolDefinition = {
  name: "notion_delete_block",
  description:
    "Delete (archive) a block by id. The block is moved to trash, not permanently removed.",
  capability: "notion.write",
  inputSchema: {
    type: "object",
    properties: { block_id: { type: "string", description: "Block id to delete." } },
    required: ["block_id"],
  },
  handler: (input, ctx) =>
    withClient(ctx, async (auth) => {
      const blockId = normalizeId(input.block_id);
      if (!blockId)
        return fail("invalid_input", "notion_delete_block requires a valid 'block_id'.");
      await notionRequest(auth, "DELETE", `/v1/blocks/${blockId}`);
      return ok(`Deleted block ${blockId}.`, { blockId });
    }),
};

const updatePagePropertiesTool: ToolDefinition = {
  name: "notion_update_page_properties",
  description:
    "Update a page's properties (status, select, title, rich_text, etc.) or archive it. Provide 'properties' as a raw Notion properties object. Set 'archived': true to send the page to trash.",
  capability: "notion.write",
  inputSchema: {
    type: "object",
    properties: {
      page_id: { type: "string", description: "Page id/URL." },
      properties: { type: "object", description: "Raw Notion properties object to set." },
      archived: { type: "boolean", description: "Archive (true) or restore (false) the page." },
    },
    required: ["page_id"],
  },
  handler: (input, ctx) =>
    withClient(ctx, async (auth) => {
      const pageId = normalizeId(input.page_id);
      if (!pageId)
        return fail("invalid_input", "notion_update_page_properties requires a valid 'page_id'.");
      const body: JsonObject = {};
      if (isObject(input.properties)) body.properties = input.properties;
      if (typeof input.archived === "boolean") body.archived = input.archived;
      if (Object.keys(body).length === 0) {
        return fail("invalid_input", "Provide 'properties' and/or 'archived'.");
      }
      const page = await notionRequest(auth, "PATCH", `/v1/pages/${pageId}`, body);
      return ok(`Updated page properties: ${summarizePage(page)}`, { pageId });
    }),
};

const createDatabaseTool: ToolDefinition = {
  name: "notion_create_database",
  description:
    "Create a new database under a parent page. Provide parent_page_id, a title, and a Notion 'properties' schema object (must include exactly one 'title' type property).",
  capability: "notion.write",
  inputSchema: {
    type: "object",
    properties: {
      parent_page_id: { type: "string", description: "Parent page id/URL." },
      title: { type: "string", description: "Database title." },
      properties: {
        type: "object",
        description:
          "Raw Notion database property schema (e.g. { Name: { title: {} }, Status: { status: {} } }).",
      },
    },
    required: ["parent_page_id", "properties"],
  },
  handler: (input, ctx) =>
    withClient(ctx, async (auth) => {
      const parentPage = normalizeId(input.parent_page_id);
      if (!parentPage)
        return fail("invalid_input", "notion_create_database requires a valid 'parent_page_id'.");
      if (!isObject(input.properties)) {
        return fail(
          "invalid_input",
          "notion_create_database requires a 'properties' schema object.",
        );
      }
      const body: JsonObject = {
        parent: { type: "page_id", page_id: parentPage },
        properties: input.properties,
      };
      const title = readString(input.title);
      if (title) body.title = toRichText(title);
      const db = await notionRequest(auth, "POST", "/v1/databases", body);
      return ok(
        `Created database "${richTextToPlain(db.title) || title || ""}" (id: ${readString(db.id) ?? "?"}).`,
        {
          databaseId: readString(db.id),
          url: readString(db.url),
        },
      );
    }),
};

const updateDatabaseTool: ToolDefinition = {
  name: "notion_update_database",
  description:
    "Update a database's title and/or property schema. Provide raw Notion 'title' rich_text and/or 'properties'.",
  capability: "notion.write",
  inputSchema: {
    type: "object",
    properties: {
      database_id: { type: "string", description: "Database id/URL." },
      title: { type: "string", description: "New database title (plain text)." },
      properties: { type: "object", description: "Raw Notion property schema changes." },
    },
    required: ["database_id"],
  },
  handler: (input, ctx) =>
    withClient(ctx, async (auth) => {
      const databaseId = normalizeId(input.database_id);
      if (!databaseId)
        return fail("invalid_input", "notion_update_database requires a valid 'database_id'.");
      const body: JsonObject = {};
      const title = readString(input.title);
      if (title) body.title = toRichText(title);
      if (isObject(input.properties)) body.properties = input.properties;
      if (Object.keys(body).length === 0)
        return fail("invalid_input", "Provide 'title' and/or 'properties'.");
      await notionRequest(auth, "PATCH", `/v1/databases/${databaseId}`, body);
      return ok(`Updated database ${databaseId}.`, { databaseId });
    }),
};

const postCommentTool: ToolDefinition = {
  name: "notion_post_comment",
  description:
    "Post a comment on a Notion page. Use for notes, status updates, or surfacing results to humans.",
  capability: "notion.write",
  inputSchema: {
    type: "object",
    properties: {
      page_id: { type: "string", description: "Page id/URL to comment on." },
      text: { type: "string", description: "Comment text." },
    },
    required: ["page_id", "text"],
  },
  handler: (input, ctx) =>
    withClient(ctx, async (auth) => {
      const pageId = normalizeId(input.page_id);
      if (!pageId) return fail("invalid_input", "notion_post_comment requires a valid 'page_id'.");
      const text = readString(input.text);
      if (!text) return fail("invalid_input", "notion_post_comment requires non-empty 'text'.");
      await notionRequest(auth, "POST", "/v1/comments", {
        parent: { page_id: pageId },
        rich_text: toRichText(text),
      });
      return ok(`Posted comment on ${pageId}.`, { pageId });
    }),
};

// ── Public catalogs ────────────────────────────────────────────────────────────

export const notionReadTools: ToolDefinition[] = [
  searchTool,
  getPageTool,
  getBlockChildrenTool,
  getDatabaseTool,
  queryDatabaseTool,
];

export const notionWriteTools: ToolDefinition[] = [
  createPageTool,
  appendBlocksTool,
  updateBlockTool,
  deleteBlockTool,
  updatePagePropertiesTool,
  createDatabaseTool,
  updateDatabaseTool,
  postCommentTool,
];

// Exported for unit tests.
export const __testing = { markdownToBlocks, normalizeId };
