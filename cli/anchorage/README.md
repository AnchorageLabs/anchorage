# cli/anchorage

The unified **`anchorage`** CLI drives the orchestrator's REST API: submit and
watch runs, approve/reject gates, inspect diffs, and manage connectors.

## Install

Self-contained binaries (no Node required) are published to GitHub Releases by
the `release-cli` workflow. One-liners pull the right one for your OS/arch:

```sh
# macOS / Linux
curl -fsSL https://github.com/AnchorageLabs/anchorage/releases/latest/download/install.sh | sh
```
```powershell
# Windows (PowerShell)
irm https://github.com/AnchorageLabs/anchorage/releases/latest/download/install.ps1 | iex
```

Builds: `anchorage-darwin-arm64`, `anchorage-darwin-x64`, `anchorage-linux-x64`,
`anchorage-windows-x64.exe` (+ `SHA256SUMS`). Override the source with
`ANCHORAGE_CLI_BASE_URL` and the install dir with `ANCHORAGE_BIN_DIR`. With Node
already on hand you can instead run from source (`pnpm -C cli/anchorage build`).

Cut a release by pushing a tag: `git tag cli-v0.1.0 && git push origin cli-v0.1.0`.

```
anchorage --server https://api.anchoragelabs.dev auth login   # store server (+ secret from env/stdin)
anchorage runs list
anchorage runs start --repo AnchorageLabs/chary --issue 6 --workflow issue-to-pr
anchorage runs watch <run-id>
anchorage connectors status
anchorage connectors connect github        # prints the authorize URL to open
```

## Config & auth

Server + secret resolution:

1. `--server <url>` flag
2. `ANCHORAGE_ORCHESTRATOR_URL` / `ORCHESTRATOR_URL`
3. `~/.config/anchoragelabs/cli.json` (written by `auth login`)
4. `http://localhost:3001`

The secret is **never** a CLI flag (shell history). `auth login` reads it from
`ANCHORAGE_ORCHESTRATOR_SECRET` / `ORCHESTRATOR_SECRET`, or from stdin when piped
(`printf %s "$SECRET" | anchorage --server <url> auth login`), and stores it 0600.

Add `--json` to any command for raw JSON output.

> Not to be confused with `cli/anchorage-runner` (the low-level agent executor).
