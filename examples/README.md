# examples

Worked examples: end-to-end flows demonstrating how the pieces fit.

> Status: scaffold. See `AGENTS.md` and `SOUL.md` at the repo root for project-wide context.

## Local issue-reader

After building the workspace:

```bash
pnpm build
pnpm --filter @anchorage/runner exec anchorage run issue-reader < examples/tasks/issue-read.json
```
