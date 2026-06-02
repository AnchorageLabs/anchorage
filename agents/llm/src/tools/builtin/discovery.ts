import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { JsonObject, ToolContext, ToolDefinition, ToolHandlerResult } from "../types.js";

interface ManifestProbe {
  filename: string;
  language: string;
  packageManager?: string;
  testHint?: string;
  lintHint?: string;
  buildHint?: string;
}

const MANIFEST_PROBES: ManifestProbe[] = [
  {
    filename: "package.json",
    language: "javascript/typescript",
    packageManager: "npm",
    testHint: "npm test",
    lintHint: "npm run lint",
    buildHint: "npm run build",
  },
  {
    filename: "go.mod",
    language: "go",
    packageManager: "go",
    testHint: "go test ./...",
    buildHint: "go build ./...",
  },
  {
    filename: "Cargo.toml",
    language: "rust",
    packageManager: "cargo",
    testHint: "cargo test",
    buildHint: "cargo build",
  },
  {
    filename: "pyproject.toml",
    language: "python",
    packageManager: "uv/poetry/pip",
    testHint: "pytest",
  },
  { filename: "requirements.txt", language: "python", packageManager: "pip", testHint: "pytest" },
  { filename: "setup.py", language: "python", packageManager: "pip", testHint: "pytest" },
  {
    filename: "Gemfile",
    language: "ruby",
    packageManager: "bundler",
    testHint: "bundle exec rspec",
  },
  {
    filename: "composer.json",
    language: "php",
    packageManager: "composer",
    testHint: "vendor/bin/phpunit",
  },
  {
    filename: "pom.xml",
    language: "java",
    packageManager: "maven",
    testHint: "mvn test",
    buildHint: "mvn package",
  },
  {
    filename: "build.gradle",
    language: "java/kotlin",
    packageManager: "gradle",
    testHint: "./gradlew test",
  },
  {
    filename: "build.gradle.kts",
    language: "kotlin",
    packageManager: "gradle",
    testHint: "./gradlew test",
  },
  { filename: "mix.exs", language: "elixir", packageManager: "mix", testHint: "mix test" },
  { filename: "Makefile", language: "make", testHint: "make test", buildHint: "make build" },
];

const MANIFEST_DOC_CANDIDATES = [
  ".anchorage/context.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".github/AGENTS.md",
];

// ── detect_project ──────────────────────────────────────────────────────────

async function detectProjectHandler(
  _input: JsonObject,
  ctx: ToolContext,
): Promise<ToolHandlerResult> {
  const found: JsonObject[] = [];
  let primaryTest: string | null = null;
  let primaryBuild: string | null = null;
  let primaryLint: string | null = null;

  for (const probe of MANIFEST_PROBES) {
    const abs = path.join(ctx.workspacePath, probe.filename);
    const stats = await stat(abs).catch(() => null);
    if (!stats?.isFile()) continue;

    const entry: JsonObject = {
      manifest: probe.filename,
      language: probe.language,
    };
    if (probe.packageManager) entry.packageManager = probe.packageManager;

    if (probe.filename === "package.json") {
      const inferred = await inferPackageJson(abs, ctx.workspacePath);
      Object.assign(entry, inferred);
      primaryTest ??= (inferred.testHint as string | undefined) ?? probe.testHint ?? null;
      primaryBuild ??= (inferred.buildHint as string | undefined) ?? probe.buildHint ?? null;
      primaryLint ??= (inferred.lintHint as string | undefined) ?? probe.lintHint ?? null;
    } else {
      if (probe.testHint) entry.testHint = probe.testHint;
      if (probe.buildHint) entry.buildHint = probe.buildHint;
      if (probe.lintHint) entry.lintHint = probe.lintHint;
      primaryTest ??= probe.testHint ?? null;
      primaryBuild ??= probe.buildHint ?? null;
      primaryLint ??= probe.lintHint ?? null;
    }

    found.push(entry);
  }

  const summary: JsonObject = {
    workspacePath: ctx.workspacePath,
    manifestsFound: found.length,
    manifests: found,
    primary: {
      test: primaryTest,
      build: primaryBuild,
      lint: primaryLint,
    },
  };

  if (found.length === 0) {
    return {
      ok: true,
      output:
        "=== detect_project ===\nNo recognized manifest in the workspace root. " +
        "Use list_dir / read_file to explore the layout.",
      bytesOut: 120,
      meta: summary,
    };
  }

  const lines: string[] = ["=== detect_project ==="];
  for (const entry of found) {
    lines.push(
      `- ${entry.manifest} → ${entry.language}` +
        (entry.packageManager ? ` [${entry.packageManager}]` : ""),
    );
    if (entry.testHint) lines.push(`    test:  ${entry.testHint}`);
    if (entry.buildHint) lines.push(`    build: ${entry.buildHint}`);
    if (entry.lintHint) lines.push(`    lint:  ${entry.lintHint}`);
  }
  if (primaryTest || primaryBuild || primaryLint) {
    lines.push("");
    lines.push("Suggested commands:");
    if (primaryTest) lines.push(`  test:  ${primaryTest}`);
    if (primaryBuild) lines.push(`  build: ${primaryBuild}`);
    if (primaryLint) lines.push(`  lint:  ${primaryLint}`);
  }

  const text = lines.join("\n");
  return { ok: true, output: text, bytesOut: text.length, meta: summary };
}

async function inferPackageJson(
  packageJsonPath: string,
  workspacePath: string,
): Promise<JsonObject> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};

  const obj = parsed as Record<string, unknown>;
  const scripts = (obj.scripts as Record<string, unknown> | undefined) ?? {};
  const packageManager = await detectNodePackageManager(workspacePath);

  const result: JsonObject = {};
  if (packageManager) result.packageManager = packageManager;
  if (typeof obj.name === "string") result.name = obj.name;
  if (typeof obj.type === "string") result.moduleType = obj.type;

  if (typeof scripts.test === "string") result.testHint = `${packageManager ?? "npm"} test`;
  if (typeof scripts.build === "string") result.buildHint = `${packageManager ?? "npm"} run build`;
  if (typeof scripts.lint === "string") result.lintHint = `${packageManager ?? "npm"} run lint`;
  if (typeof scripts.typecheck === "string")
    result.typecheckHint = `${packageManager ?? "npm"} run typecheck`;

  const deps = (obj.dependencies as Record<string, unknown> | undefined) ?? {};
  const devDeps = (obj.devDependencies as Record<string, unknown> | undefined) ?? {};
  const frameworks: string[] = [];
  for (const dep of [...Object.keys(deps), ...Object.keys(devDeps)]) {
    if (dep === "react" || dep === "vue" || dep === "svelte") frameworks.push(dep);
    if (dep === "next" || dep === "nuxt" || dep === "astro") frameworks.push(dep);
    if (dep === "vitest" || dep === "jest" || dep === "mocha") frameworks.push(dep);
    if (dep === "fastify" || dep === "express" || dep === "hono") frameworks.push(dep);
  }
  if (frameworks.length > 0) result.frameworks = frameworks;

  return result;
}

async function detectNodePackageManager(workspacePath: string): Promise<string | null> {
  for (const [lock, name] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ] as const) {
    const exists = await stat(path.join(workspacePath, lock)).catch(() => null);
    if (exists?.isFile()) return name;
  }
  return null;
}

export const detectProjectTool: ToolDefinition = {
  name: "detect_project",
  description:
    "Inspect the workspace root for known manifest files (package.json, go.mod, Cargo.toml, " +
    "pyproject.toml, pom.xml, Gemfile, etc.) and infer language, package manager, and " +
    "test/build/lint commands. Always safe to call once at the start of a run.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  capability: "repo.read",
  handler: detectProjectHandler,
};

// ── read_repo_manifest ──────────────────────────────────────────────────────

async function readRepoManifestHandler(
  _input: JsonObject,
  ctx: ToolContext,
): Promise<ToolHandlerResult> {
  for (const candidate of MANIFEST_DOC_CANDIDATES) {
    const abs = path.join(ctx.workspacePath, candidate);
    const stats = await stat(abs).catch(() => null);
    if (!stats?.isFile()) continue;
    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    // Cap at 32 KB — agent context manifests should be tight.
    const truncated = content.length > 32_000;
    const body = truncated ? `${content.slice(0, 32_000)}\n…[truncated]` : content;
    return {
      ok: true,
      output: `=== repo manifest: ${candidate} ===\n${body}`,
      bytesOut: body.length,
      meta: { path: candidate, bytes: body.length, totalBytes: content.length },
    };
  }
  return {
    ok: true,
    output:
      "=== repo manifest ===\nNo AGENTS.md / CLAUDE.md / .anchorage/context.md found in this " +
      "workspace. Use detect_project, list_dir, and read_file to build up context.",
    bytesOut: 200,
    meta: { found: false },
  };
}

export const readRepoManifestTool: ToolDefinition = {
  name: "read_repo_manifest",
  description:
    "Opportunistically read AGENTS.md / CLAUDE.md / .anchorage/context.md if the target repo " +
    "ships one. Returns a note when none exists — never fails. Use this once at the start to " +
    "pick up project-specific conventions when present.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  capability: "repo.read",
  handler: readRepoManifestHandler,
};

export const discoveryTools: ToolDefinition[] = [detectProjectTool, readRepoManifestTool];
