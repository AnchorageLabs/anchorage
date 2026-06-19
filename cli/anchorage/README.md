# cli/anchorage

The unified **`anchorage`** CLI — a scriptable sibling to the TUI that drives the
orchestrator's REST API: submit and watch runs, approve/reject gates, inspect
diffs, and manage the GitHub/Notion connectors.

```
anchorage --server https://api.anchoragelabs.dev auth login   # store server (+ secret from env/stdin)
anchorage runs list
anchorage runs start --repo AnchorageLabs/chary --issue 6 --workflow issue-to-pr
anchorage runs watch <run-id>
anchorage connectors status
anchorage connectors connect github        # prints the authorize URL to open
```

## Config & auth

Server + secret resolve exactly like the TUI, so one login serves both:

1. `--server <url>` flag
2. `ANCHORAGE_ORCHESTRATOR_URL` / `ORCHESTRATOR_URL`
3. `~/.config/anchoragelabs/cli.json` (written by `auth login`)
4. `http://localhost:3001`

The secret is **never** a CLI flag (shell history). `auth login` reads it from
`ANCHORAGE_ORCHESTRATOR_SECRET` / `ORCHESTRATOR_SECRET`, or from stdin when piped
(`printf %s "$SECRET" | anchorage --server <url> auth login`), and stores it 0600.

Add `--json` to any command for raw JSON output.

> Not to be confused with `cli/anchorage-runner` (the low-level agent executor).
