# Anchorage CLI

The unified **`anchorage`** CLI drives the Anchorage orchestrator's REST API: submit and watch runs, approve/reject gates, inspect diffs, manage connectors, and configure your account model.

## Install

Self-contained binaries (no Node.js required) are published to GitHub Releases. The installer always fetches the **latest** version and verifies the download against `SHA256SUMS` before installing.

### macOS / Linux

```sh
curl -fsSL https://github.com/AnchorageLabs/anchorage/releases/latest/download/install.sh | sh
```

The installer places `anchorage` in `/usr/local/bin` if it is writable, otherwise in `~/.local/bin`. If `~/.local/bin` is not on your `PATH`, run the export command printed at the end of the install.

### Windows (PowerShell)

```powershell
irm https://github.com/AnchorageLabs/anchorage/releases/latest/download/install.ps1 | iex
```

The installer places `anchorage.exe` under `%LOCALAPPDATA%\Anchorage\bin` and adds it to your user `PATH`.

### Verify the install

```sh
anchorage --version
```

You should see the latest release version, for example:

```
anchorage 0.1.1
```

### Advanced install options

- Override the install directory:

  ```sh
  ANCHORAGE_BIN_DIR=/custom/bin curl -fsSL https://github.com/AnchorageLabs/anchorage/releases/latest/download/install.sh | sh
  ```

- Pin to a specific release instead of `latest`:

  ```sh
  ANCHORAGE_CLI_BASE_URL=https://github.com/AnchorageLabs/anchorage/releases/download/cli-v0.1.0 \
    curl -fsSL https://github.com/AnchorageLabs/anchorage/releases/download/cli-v0.1.0/install.sh | sh
  ```

- Build from source (requires Node.js >= 22 and pnpm):

  ```sh
  pnpm -C cli/anchorage build
  ```

## Quick start

```sh
# 1. Log in (default server: https://api.anchoragelabs.dev)
#    The secret is read from ANCHORAGE_ORCHESTRATOR_SECRET or stdin, never as a flag.
export ANCHORAGE_ORCHESTRATOR_SECRET="your-secret"
anchorage auth login

# 2. Check who you are
anchorage auth whoami

# 3. List recent runs
anchorage runs list

# 4. Start a run from an issue
anchorage runs start --repo AnchorageLabs/chary --issue 6 --workflow issue-to-pr

# 5. Watch a run live
anchorage runs watch <run-id>

# 6. Inspect the resulting diff
anchorage runs diff <run-id>
```

## Authentication

The CLI never accepts a secret as a command-line flag (to avoid shell history). The secret is resolved in this order:

1. `ANCHORAGE_ORCHESTRATOR_SECRET` environment variable
2. `ORCHESTRATOR_SECRET` environment variable
3. `~/.config/anchoragelabs/cli.json` (written by `anchorage auth login`)

When piping a secret into `auth login`:

```sh
printf '%s' "$ANCHORAGE_ORCHESTRATOR_SECRET" | anchorage auth login
```

The config file is created with permissions `0600` so only your user can read it.

## Server resolution

The orchestrator base URL is resolved in this order:

1. `--server <url>` flag
2. `ANCHORAGE_ORCHESTRATOR_URL` / `ORCHESTRATOR_URL` environment variables
3. `~/.config/anchoragelabs/cli.json` (written by `auth login`)
4. `https://api.anchoragelabs.dev` (default)

For local development:

```sh
anchorage --server http://localhost:3001 runs list
```

## Common commands

### Runs

```sh
anchorage runs list
anchorage runs start --repo <owner/repo> --issue <n> [--workflow <name>]
anchorage runs start --repo <owner/repo> --instruction "Add a dark mode toggle"
anchorage runs start --repo <owner/repo> --issue <n> --workflow issue-to-pr --llm-provider openai --llm-model gpt-4.1
anchorage runs status <run-id>
anchorage runs watch <run-id>
anchorage runs approve <run-id>
anchorage runs reject <run-id>
anchorage runs cancel <run-id>
anchorage runs resume <run-id> [--instruction "Try a different approach"]
anchorage runs diff <run-id>
```

### Connectors

```sh
anchorage connectors status
anchorage connectors connect github
anchorage connectors disconnect github
```

### Workflows, repos, and issues

```sh
anchorage workflows list
anchorage repos list
anchorage issues list <owner/repo>
```

### Model configuration

```sh
anchorage model status
ANCHORAGE_MODEL_API_KEY="sk-..." anchorage model set openai gpt-4.1
anchorage model use anthropic claude-sonnet-4
```

## JSON output

Add `--json` to any command to get raw JSON output:

```sh
anchorage --json runs list
```

## Updating

Re-run the install command above; it always downloads the latest release and replaces the existing binary after verifying the checksum.

```sh
curl -fsSL https://github.com/AnchorageLabs/anchorage/releases/latest/download/install.sh | sh
```

## Security

- Secrets are never accepted as CLI flags.
- Stored credentials live in `~/.config/anchoragelabs/cli.json` with `0600` permissions.
- The installer verifies every binary against the published `SHA256SUMS` before placing it on your system.

## Not to be confused with

- `cli/anchorage-runner` — the low-level agent executor (`anchorage run <agent> < input.json`).
