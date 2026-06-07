# runtime agent

The **pre-merge execution gate**. It runs after the reviewer and before the
merge gate: it takes the reviewed change, figures out how to run the solution
locally, starts it, and exposes a **preview URL** so a human can inspect the
running change before it merges.

It is intentionally **optional**. If there is nothing to preview — a
documentation-only change, a library with no runnable entrypoint, or a solution
with no local run strategy — the agent reports `not_applicable` and the pipeline
continues to merge without pausing.

## Task

- **Task type:** `runtime.start`
- **Input:** `input.workspacePath` — the repository worktree. The coder's
  `code.change.result` (in `context.priorArtifacts`) is used to detect
  documentation-only changes.
- **Output:** a `runtime.preview` artifact (and matching `agent.output` event).
- **Requires:** `workspace.read`, `shell.exec`.

## Outcome (`runtime.preview.status`)

| status           | meaning                                              | exit code | pipeline effect                    |
| ---------------- | ---------------------------------------------------- | --------- | ---------------------------------- |
| `running`        | services started, `previewUrl` is reachable          | 0         | pause for human approve / reject   |
| `not_applicable` | nothing to run (docs-only / no run strategy)         | 0         | continue to merge, no pause        |
| `failed`         | a runnable solution was detected but would not start | 9         | finish the run **without** merging |

The orchestrator's approval gate reads `status` (pause only on `running`) and
`previewUrl`.

## Strategy cache — `.anchorage/runtime.json`

On the first successful run the agent writes the working strategy to
`.anchorage/runtime.json` in the repo root. Later runs read it **first** to skip
detection and start faster, and rewrite it when the working strategy changes. The
file can also be hand-authored to teach the agent how to run an exotic stack:

```json
{
  "kind": "node",
  "startCommand": "pnpm run dev",
  "port": 5173,
  "url": "http://localhost:5173",
  "stopCommand": "pkill -f vite"
}
```

## Detection (when there is no cache)

In priority order:

1. **docker-compose** — `docker-compose.yml` / `compose.yaml`. Runs
   `docker compose up -d --build`; preview port read from the first `ports:` map.
2. **node** — a `package.json` with a `dev` / `start` / `serve` script. Installs
   dependencies (pnpm/yarn/npm/bun auto-detected) then runs the script detached;
   port inferred from the script or the framework (Vite 5173, Next/CRA 3000, …),
   overridable with `ANCHORAGE_RUNTIME_PORT`.
3. **static** — a root `index.html`, served with `python3 -m http.server`.

Anything else → `not_applicable`.

Long-running servers (node/static) are spawned **detached** so the preview stays
up across the human-inspection pause; logs go to `.anchorage/runtime.log`. The
`stopCommand` in the artifact / cache tears them down.

## Environment

- `ANCHORAGE_RUNTIME_PORT` — override the detected preview port.
- `ANCHORAGE_RUNTIME_INSTALL_TIMEOUT_MS` — dependency-install timeout (default 300000).
- `ANCHORAGE_ARTIFACT_DIR` — where the `runtime.preview` artifact is written.
