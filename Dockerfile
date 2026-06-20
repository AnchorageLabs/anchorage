# Dockerfile for Anchorage Agent Runner
# Multi-stage build for production-ready container

FROM node:22-alpine AS base

# Install pnpm
RUN npm install -g pnpm@9.15.9

WORKDIR /app

# Copy workspace configuration
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./

# Copy protocol package (dependency for SDK)
COPY protocol ./protocol

# Copy SDK
COPY sdk/typescript ./sdk/typescript

# Copy CLI runner
COPY cli/anchorage-runner ./cli/anchorage-runner

# Copy all agents
COPY agents ./agents

# Install dependencies
RUN pnpm install --frozen-lockfile

# Build all packages
RUN pnpm -r build

# Production stage
FROM node:22-alpine AS production

RUN npm install -g pnpm@9.15.9

WORKDIR /app

# Copy built artifacts and node_modules from base
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/package.json ./package.json
COPY --from=base /app/pnpm-workspace.yaml ./pnpm-workspace.yaml

# Copy each package's built output and package.json
COPY --from=base /app/protocol ./protocol

COPY --from=base /app/sdk/typescript/dist ./sdk/typescript/dist
COPY --from=base /app/sdk/typescript/package.json ./sdk/typescript/package.json

COPY --from=base /app/cli/anchorage-runner/dist ./cli/anchorage-runner/dist
COPY --from=base /app/cli/anchorage-runner/package.json ./cli/anchorage-runner/package.json

COPY --from=base /app/agents/llm/dist ./agents/llm/dist
COPY --from=base /app/agents/llm/package.json ./agents/llm/package.json

# Copy all agent built outputs
COPY --from=base /app/agents/issue-reader/dist ./agents/issue-reader/dist
COPY --from=base /app/agents/issue-reader/package.json ./agents/issue-reader/package.json
COPY --from=base /app/agents/issue-reader/agent.json ./agents/issue-reader/agent.json

COPY --from=base /app/agents/planner/dist ./agents/planner/dist
COPY --from=base /app/agents/planner/package.json ./agents/planner/package.json
COPY --from=base /app/agents/planner/agent.json ./agents/planner/agent.json

COPY --from=base /app/agents/coder/dist ./agents/coder/dist
COPY --from=base /app/agents/coder/package.json ./agents/coder/package.json
COPY --from=base /app/agents/coder/agent.json ./agents/coder/agent.json

COPY --from=base /app/agents/pr-opener/dist ./agents/pr-opener/dist
COPY --from=base /app/agents/pr-opener/package.json ./agents/pr-opener/package.json
COPY --from=base /app/agents/pr-opener/agent.json ./agents/pr-opener/agent.json

COPY --from=base /app/agents/reviewer/dist ./agents/reviewer/dist
COPY --from=base /app/agents/reviewer/package.json ./agents/reviewer/package.json
COPY --from=base /app/agents/reviewer/agent.json ./agents/reviewer/agent.json

COPY --from=base /app/agents/merge-gate/dist ./agents/merge-gate/dist
COPY --from=base /app/agents/merge-gate/package.json ./agents/merge-gate/package.json
COPY --from=base /app/agents/merge-gate/agent.json ./agents/merge-gate/agent.json

COPY --from=base /app/agents/tester/dist ./agents/tester/dist
COPY --from=base /app/agents/tester/package.json ./agents/tester/package.json
COPY --from=base /app/agents/tester/agent.json ./agents/tester/agent.json

COPY --from=base /app/agents/ci-watcher/dist ./agents/ci-watcher/dist
COPY --from=base /app/agents/ci-watcher/package.json ./agents/ci-watcher/package.json
COPY --from=base /app/agents/ci-watcher/agent.json ./agents/ci-watcher/agent.json

COPY --from=base /app/agents/deploy-watch/dist ./agents/deploy-watch/dist
COPY --from=base /app/agents/deploy-watch/package.json ./agents/deploy-watch/package.json
COPY --from=base /app/agents/deploy-watch/agent.json ./agents/deploy-watch/agent.json

COPY --from=base /app/agents/smoke-test-runner/dist ./agents/smoke-test-runner/dist
COPY --from=base /app/agents/smoke-test-runner/package.json ./agents/smoke-test-runner/package.json
COPY --from=base /app/agents/smoke-test-runner/agent.json ./agents/smoke-test-runner/agent.json

COPY --from=base /app/agents/issue-closer/dist ./agents/issue-closer/dist
COPY --from=base /app/agents/issue-closer/package.json ./agents/issue-closer/package.json
COPY --from=base /app/agents/issue-closer/agent.json ./agents/issue-closer/agent.json

COPY --from=base /app/agents/issue-triage/dist ./agents/issue-triage/dist
COPY --from=base /app/agents/issue-triage/package.json ./agents/issue-triage/package.json
COPY --from=base /app/agents/issue-triage/agent.json ./agents/issue-triage/agent.json

COPY --from=base /app/agents/issue-opener/dist ./agents/issue-opener/dist
COPY --from=base /app/agents/issue-opener/package.json ./agents/issue-opener/package.json
COPY --from=base /app/agents/issue-opener/agent.json ./agents/issue-opener/agent.json

COPY --from=base /app/agents/notion-reader/dist ./agents/notion-reader/dist
COPY --from=base /app/agents/notion-reader/package.json ./agents/notion-reader/package.json
COPY --from=base /app/agents/notion-reader/agent.json ./agents/notion-reader/agent.json

COPY --from=base /app/agents/notion-writer/dist ./agents/notion-writer/dist
COPY --from=base /app/agents/notion-writer/package.json ./agents/notion-writer/package.json
COPY --from=base /app/agents/notion-writer/agent.json ./agents/notion-writer/agent.json

COPY --from=base /app/agents/notion-worker/dist ./agents/notion-worker/dist
COPY --from=base /app/agents/notion-worker/package.json ./agents/notion-worker/package.json
COPY --from=base /app/agents/notion-worker/agent.json ./agents/notion-worker/agent.json

COPY --from=base /app/agents/gitlab-reader/dist ./agents/gitlab-reader/dist
COPY --from=base /app/agents/gitlab-reader/package.json ./agents/gitlab-reader/package.json
COPY --from=base /app/agents/gitlab-reader/agent.json ./agents/gitlab-reader/agent.json

COPY --from=base /app/agents/gitlab-pr-opener/dist ./agents/gitlab-pr-opener/dist
COPY --from=base /app/agents/gitlab-pr-opener/package.json ./agents/gitlab-pr-opener/package.json
COPY --from=base /app/agents/gitlab-pr-opener/agent.json ./agents/gitlab-pr-opener/agent.json

COPY --from=base /app/agents/bitbucket-reader/dist ./agents/bitbucket-reader/dist
COPY --from=base /app/agents/bitbucket-reader/package.json ./agents/bitbucket-reader/package.json
COPY --from=base /app/agents/bitbucket-reader/agent.json ./agents/bitbucket-reader/agent.json

COPY --from=base /app/agents/bitbucket-pr-opener/dist ./agents/bitbucket-pr-opener/dist
COPY --from=base /app/agents/bitbucket-pr-opener/package.json ./agents/bitbucket-pr-opener/package.json
COPY --from=base /app/agents/bitbucket-pr-opener/agent.json ./agents/bitbucket-pr-opener/agent.json

COPY --from=base /app/agents/jira-reader/dist ./agents/jira-reader/dist
COPY --from=base /app/agents/jira-reader/package.json ./agents/jira-reader/package.json
COPY --from=base /app/agents/jira-reader/agent.json ./agents/jira-reader/agent.json

COPY --from=base /app/agents/linear-reader/dist ./agents/linear-reader/dist
COPY --from=base /app/agents/linear-reader/package.json ./agents/linear-reader/package.json
COPY --from=base /app/agents/linear-reader/agent.json ./agents/linear-reader/agent.json

COPY --from=base /app/agents/runtime/dist ./agents/runtime/dist
COPY --from=base /app/agents/runtime/package.json ./agents/runtime/package.json
COPY --from=base /app/agents/runtime/agent.json ./agents/runtime/agent.json

COPY --from=base /app/agents/policy-check/dist ./agents/policy-check/dist
COPY --from=base /app/agents/policy-check/package.json ./agents/policy-check/package.json
COPY --from=base /app/agents/policy-check/agent.json ./agents/policy-check/agent.json

# Set environment
ENV NODE_ENV=production
ENV PATH="/app/cli/anchorage-runner/dist:${PATH}"

ENTRYPOINT ["node", "/app/cli/anchorage-runner/dist/index.js"]
CMD ["--help"]
