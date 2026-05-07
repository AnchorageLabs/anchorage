# examples

Worked examples: end-to-end flows demonstrating how the pieces fit.

> Status: scaffold. See `AGENTS.md` and `SOUL.md` at the repo root for project-wide context.

## issue-reader

Reads a real GitHub issue through the reference runner. Requires a token with `repo` read scope in `GH_TOKEN` or `GITHUB_TOKEN`.

```bash
pnpm install
pnpm -r build
GH_TOKEN=$(gh auth token) node cli/anchorage-runner/dist/index.js \
  run issue-reader < examples/tasks/issue-read.json
```

The example task targets `AnchorageLabs/anchorage#1`. Edit `examples/tasks/issue-read.json` to point at any other public or accessible issue.
