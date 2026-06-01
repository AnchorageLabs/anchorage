# CodeGraph (local dev tool)

CodeGraph is a tree-sitter-based static index of this monorepo. It runs **only
on your machine** and is never wired into any agent's prompts — same precedent
as [`anchorage-orchestrator#41`](https://github.com/AnchorageLabs/anchorage-orchestrator/pull/41)
(agents stay deterministic; structural intelligence is for the human in the
loop). The index spans the whole workspace: `protocol/`, `sdk/typescript/`,
`agents/*`, and `cli/anchorage-runner/`.

Use it to answer cross-package structural questions:

- "Which agents break if I change `ExitCode` in `sdk/typescript`?"
- "What calls `requestLlmCompletion`?"
- "What's the blast radius of changing the `TaskEnvelope` type?"

That last one used to be N greps across 9+ agent packages; now it's one
`impact` query. You can hit it through Claude Code's MCP integration or directly
from the shell.

## Setup

CodeGraph runs through `npx`, so there is nothing to install globally. Build the
index once:

```bash
make codegraph-init   # writes .codegraph/codegraph.db (gitignored)
```

The MCP server auto-syncs on file changes. Manual commands if you need them:

```bash
npx -y @colbymchenry/codegraph index    # full rebuild after a large refactor
npx -y @colbymchenry/codegraph sync     # incremental update
npx -y @colbymchenry/codegraph status   # stats / staleness
```

## MCP (Claude Code)

`.mcp.json` at the repo root registers CodeGraph as a stdio MCP server. The next
Claude Code session opened in this directory will expose tools like
`mcp__codegraph__codegraph_search`, `_callers`, `_callees`, `_impact`,
`_context`, `_files`, `_node`, `_status`.

To auto-allow them (no prompt each call), add to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__codegraph__codegraph_search",
      "mcp__codegraph__codegraph_context",
      "mcp__codegraph__codegraph_callers",
      "mcp__codegraph__codegraph_callees",
      "mcp__codegraph__codegraph_impact",
      "mcp__codegraph__codegraph_node",
      "mcp__codegraph__codegraph_status",
      "mcp__codegraph__codegraph_files"
    ]
  }
}
```

## Shell

```bash
npx -y @colbymchenry/codegraph query 'requestLlmCompletion'
npx -y @colbymchenry/codegraph callers parseNdjsonEvents
npx -y @colbymchenry/codegraph impact ExitCode      # which agents need re-testing
```

## Not in scope

CodeGraph is intentionally **not** injected into the prompts of `coder`,
`planner`, or any other agent. The agents are deterministic TS programs that
assemble their own context; feeding CodeGraph output into their prompts is a
separate decision. OpenObserve / OTel exporters are also out of scope here — the
orchestrator already observes agent runs externally.
