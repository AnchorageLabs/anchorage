# notion-worker

An LLM agent that **acts on a Notion workspace** through the Notion API to
satisfy a task: take notes, manage tasks, organize databases, and build
structured wikis. It is the Notion-native counterpart of the `coder` agent —
where `coder` writes code into a repo, `notion-worker` writes changes into
Notion. It never touches GitHub.

## Task

- **Type:** `notion.task.act`
- **Capabilities required:** `notion.read`, `notion.write`, `llm.code`
- **Reads:** the originating page from a prior `issue.summary` artifact (emitted
  by `notion-reader`), or a direct `input.instruction` / `input.pageId`.
- **Emits:** a `notion.task.result` artifact (`summary`, `operations[]`,
  `risks[]`).

## Tools

The agent drives a tool loop with the Notion tools from `@anchorage/agent-llm`:

- Read: `notion_search`, `notion_get_page`, `notion_get_block_children`,
  `notion_get_database`, `notion_query_database`.
- Write: `notion_create_page`, `notion_append_blocks`, `notion_update_block`,
  `notion_delete_block`, `notion_update_page_properties`,
  `notion_create_database`, `notion_update_database`, `notion_post_comment`.

Page bodies accept a simple `markdown` argument (headings, bullets, todos,
code, quotes) that is converted to Notion blocks, or raw Notion block JSON for
full control.

## Configuration

- `NOTION_TOKEN` / `NOTION_API_KEY` — the connector's integration token. The
  agent can only touch pages/databases shared with this integration; that share
  boundary is the security perimeter.
- `NOTION_VERSION` (default `2022-06-28`), `NOTION_API_BASE_URL`.
- LLM model via `ANCHORAGE_NOTION-WORKER_MODEL` / `ANCHORAGE_LLM_MODEL` (see
  `resolveLlmConfig`).
- `ANCHORAGE_NOTION_WORKER_MAX_TOKENS_PER_TURN` (default 8000).
