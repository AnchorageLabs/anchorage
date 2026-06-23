// Builds the throwaway Vite harness that renders changed components in
// isolation, for whichever framework the repo uses. Pure: every builder returns
// file {path, content} pairs the caller writes under `<appRoot>/.anchorage/preview/`.
// The harness NEVER imports the app's entry point — only the changed components
// (via generated stories under `stories/`), so it comes up without the app's
// auth/data/secret machinery.
//
// Fidelity comes from two things: the repo's global stylesheets are imported
// into the harness, and the framework runtime is de-duped to the app's own copy
// so component state/hooks work across the module boundary.
//
// Per-framework templates live in the FRAMEWORK_TEMPLATES registry. React/Preact,
// Vue, Svelte and Solid each ship a deterministic template; anything else is
// handled by the LLM general path in the caller. A template that fails to come
// up is NOT fatal — the caller falls through to the LLM path.

import path from "node:path";
import { buildStoryFor } from "./stories.js";
import type { FrontendFramework, FrontendToolchain } from "./toolchain.js";

export interface HarnessFile {
  /** Path relative to the harness root (.anchorage/preview). */
  path: string;
  content: string;
}

export interface BuildHarnessArgs {
  toolchain: FrontendToolchain;
  /** Port the harness dev server binds to. */
  port: number;
  /**
   * Absolute dir of the framework runtime package as installed for the app
   * (e.g. <appRoot>/node_modules/react), or null when not resolvable. Used to
   * pin a single copy of the runtime so cross-boundary state works.
   */
  frameworkDir: string | null;
  /** Absolute dir of react-dom (react/preact family only), or null. */
  reactDomDir?: string | null;
  /**
   * Absolute dir of the APP's PostCSS config (postcss.config.*), or null. When
   * set, the harness points Vite's `css.postcss` at it so the app's REAL PostCSS
   * pipeline (Tailwind v3/v4, autoprefixer, nesting — whatever the app uses)
   * runs, resolving plugins from the app's own installed node_modules. When null,
   * `css.postcss` is pinned to an empty config so Vite never walks up and
   * auto-loads a config whose plugins the isolated harness lacks (which crashes
   * startup). Either way the app's config is never inherited by accident.
   */
  postcssConfigDir?: string | null;
  /**
   * Module aliases the app declares (tsconfig `compilerOptions.paths`, etc.),
   * with absolute replacements — so component imports like `@/`, `~/`,
   * `@components/` resolve regardless of the app's alias scheme. Merged with the
   * framework's own runtime aliases.
   */
  aliasEntries?: AliasEntry[];
}

/** A module alias: `find` (import prefix) → `replacement` (absolute path). */
export interface AliasEntry {
  find: string;
  replacement: string;
}

/** The directory (relative to the harness root) where generated stories live. */
export const STORIES_DIR = "src/stories";

/**
 * Dev-server route the harness exposes so the orchestrator can learn which
 * cards actually RENDER vs. throw for missing context/props. The gallery is a
 * client-rendered SPA — a plain HTTP GET of `/` only ever sees the empty shell,
 * so a render failure (e.g. a component that needs `<LogtoProvider>`) is
 * invisible to a server-side probe. This route renders each story server-side
 * inside the dev server and returns the pass/fail list, no browser required.
 */
export const RENDER_PROBE_PATH = "/__anchorage/render";

interface FrameworkTemplate {
  /** Source extensions for components this framework can render as a story. */
  componentExtensions: string[];
  /** Harness-local devDependencies (vite plugin + anything the entry needs). */
  devDependencies: Record<string, string>;
  /** Build the skeleton files (everything but the per-component stories). */
  buildSkeleton(args: BuildHarnessArgs): HarnessFile[];
}

// ── Shared building blocks ────────────────────────────────────────────────────

function harnessPackageJson(deps: Record<string, string>): string {
  return `${JSON.stringify(
    {
      name: "anchorage-preview-harness",
      private: true,
      type: "module",
      scripts: { dev: "vite" },
      // Vite + the framework plugin go in `dependencies`, NOT `devDependencies`,
      // so they install even when the runtime container runs with
      // NODE_ENV=production (which makes `npm install` skip devDependencies and
      // would leave `vite` absent → "vite: not found"). The harness is a
      // throwaway dev app; the dev/prod split is meaningless here anyway.
      dependencies: deps,
    },
    null,
    2,
  )}\n`;
}

interface ViteConfigArgs {
  appRoot: string;
  installRoot: string;
  port: number;
  /** e.g. `import react from "@vitejs/plugin-react";` */
  pluginImport: string;
  /** e.g. `react()` — inserted into the plugins array. */
  pluginUse: string;
  /** Packages to dedupe to a single copy. */
  dedupe: string[];
  /** Resolve.alias entries (framework runtime + the app's declared aliases). */
  aliasEntries: AliasEntry[];
  /** Dir of the app's PostCSS config to reuse, or null to isolate (empty). */
  postcssConfigDir: string | null;
  /**
   * Add a dev-server route ({@link RENDER_PROBE_PATH}) that server-side renders
   * each story and reports which threw — so the orchestrator can detect cards
   * that can't render in isolation (missing providers/props) and escalate to the
   * mock-provider LLM path. React only: it relies on `react-dom/server`.
   */
  ssrRenderProbe: boolean;
}

/** Harness-relative path of the SSR render-probe entry module (React only). */
const RENDER_PROBE_MODULE = "src/__anchorage_probe.jsx";

// The render-probe ENTRY MODULE. It must import react/react-dom the ordinary way
// and discover stories via `import.meta.glob`, so Vite's SSR pipeline transforms
// everything (aliases, TS, CSS-as-empty) and EXTERNALIZES react for us. We do NOT
// `ssrLoadModule("react")` directly from the plugin — Vite then evaluates React's
// CJS as ESM and dies with "module is not defined". Each story is rendered with
// `renderToStaticMarkup`; a synchronous render throw (the missing-context class
// we care about: `useLogto`, router/query hooks, required props) is caught and
// reported as a failure. No browser involved.
function renderProbeEntryModule(): string {
  return `import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const stories = import.meta.glob("./stories/*.{jsx,tsx}");

export async function runProbe() {
  const out = [];
  for (const [path, load] of Object.entries(stories)) {
    const fallbackName = path.replace(/^\\.\\/stories\\//, "").replace(/\\.[jt]sx$/, "");
    let mod;
    try {
      mod = await load();
    } catch (err) {
      out.push({ name: fallbackName, ok: false, error: String((err && err.message) || err) });
      continue;
    }
    const name = (mod && mod.title) || fallbackName;
    try {
      renderToStaticMarkup(React.createElement(mod.default));
      out.push({ name, ok: true, error: null });
    } catch (err) {
      out.push({ name, ok: false, error: String((err && err.message) || err) });
    }
  }
  return out;
}
`;
}

// The dev-server plugin backing RENDER_PROBE_PATH: it loads the probe entry
// module via SSR and returns its `[{ name, ok, error }]` report. Anything the
// verifier itself can't do (module fails to load, etc.) degrades to an empty
// list, so the orchestrator assumes the cards rendered — detection can only ADD a
// warning/escalation on a real failure, never make the preview worse than before.
function ssrRenderProbePlugin(): string {
  return `function anchorageRenderProbe() {
  return {
    name: "anchorage-render-probe",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(${JSON.stringify(RENDER_PROBE_PATH)}, async (_req, res) => {
        let out = [];
        try {
          const probe = await server.ssrLoadModule("/" + ${JSON.stringify(RENDER_PROBE_MODULE)});
          out = await probe.runProbe();
        } catch (err) {
          // Verifier unavailable — report nothing.
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out));
      });
    },
  };
}
`;
}

function aliasArrayLiteral(entries: AliasEntry[]): string {
  if (entries.length === 0) return "[]";
  const lines = entries
    .map(
      (e) =>
        `      { find: ${JSON.stringify(e.find)}, replacement: ${JSON.stringify(e.replacement)} }`,
    )
    .join(",\n");
  return `[\n${lines},\n    ]`;
}

function postcssLiteral(dir: string | null): string {
  // A string path makes Vite load the app's REAL config (plugins resolve from
  // the app's own node_modules). An inline empty object pins PostCSS off AND
  // stops Vite from walking up to auto-load a config the isolated harness can't
  // satisfy — either way the app's config is never inherited by accident.
  return dir ? JSON.stringify(dir) : "{ plugins: [] }";
}

function viteConfig(args: ViteConfigArgs): string {
  const appRoot = JSON.stringify(args.appRoot);
  const installRoot = JSON.stringify(args.installRoot);
  const dedupe = JSON.stringify(args.dedupe);
  const probePlugin = args.ssrRenderProbe ? ssrRenderProbePlugin() : "";
  const pluginUses = args.ssrRenderProbe
    ? `${args.pluginUse}, anchorageRenderProbe()`
    : args.pluginUse;
  // Keep react/react-dom EXTERNAL for SSR so the render-probe loads them via
  // native require (CJS) instead of Vite evaluating their CJS as ESM (which dies
  // with "module is not defined"). They resolve from the app's node_modules — the
  // harness is nested inside appRoot, so the require walk-up finds the app's copy.
  const ssrBlock = args.ssrRenderProbe
    ? `  ssr: {\n    external: ["react", "react-dom"],\n  },\n`
    : "";
  return `import { defineConfig } from "vite";
${args.pluginImport}
${probePlugin}
// The frontend app root. The harness lives at <appRoot>/.anchorage/preview.
const appRoot = ${appRoot};
// Where the app's dependencies are installed (workspace/monorepo root or appRoot).
const installRoot = ${installRoot};

// https://vitejs.dev/config/ — generated by the Anchorage runtime agent.
export default defineConfig({
  root: __dirname,
  plugins: [${pluginUses}],
  server: {
    port: ${args.port},
    host: "0.0.0.0",
    strictPort: false,
    // Let Vite read component sources + hoisted deps from anywhere on the chain.
    fs: { allow: [__dirname, appRoot, installRoot] },
  },
  css: {
    postcss: ${postcssLiteral(args.postcssConfigDir)},
  },
  resolve: {
    // One framework copy only — state/hooks must run in the same runtime as the
    // harness, even across the repo/harness module boundary.
    dedupe: ${dedupe},
    // Framework runtime + the app's own declared aliases (tsconfig paths, etc.),
    // so component imports resolve regardless of the app's alias scheme.
    alias: ${aliasArrayLiteral(args.aliasEntries)},
  },
${ssrBlock}});
`;
}

function indexHtml(entrySrc: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Anchorage · component preview</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${entrySrc}"></script>
  </body>
</html>
`;
}

function cssImportLines(args: BuildHarnessArgs): string {
  const { toolchain } = args;
  return toolchain.globalCss
    .map((rel) => `import ${JSON.stringify(path.join(toolchain.appRoot, rel))};`)
    .join("\n");
}

const GALLERY_HEADER_NOTE = "rendered in isolation with mock data — the app itself is not running.";

// ── React / Preact ─────────────────────────────────────────────────────────────

// The full alias set for a harness: the framework's own runtime aliases, plus
// the app's declared aliases, plus a default "@" -> src when the app didn't
// already define one. All replacements are absolute.
function resolveAliasEntries(args: BuildHarnessArgs, frameworkEntries: AliasEntry[]): AliasEntry[] {
  const entries = [...frameworkEntries, ...(args.aliasEntries ?? [])];
  if (!entries.some((e) => e.find === "@")) {
    entries.push({ find: "@", replacement: path.join(args.toolchain.appRoot, "src") });
  }
  return entries;
}

// NOTE: React/react-dom are pinned to the app's single copy via `resolve.dedupe`
// (see viteConfig), NOT a `resolve.alias` to an absolute dir. An absolute-path
// alias defeats Vite's SSR externalization of react — the render probe then
// evaluates React's CJS as ESM and dies with "module is not defined". dedupe
// gives the same single-runtime guarantee (the reason hooks/state work across the
// repo/harness boundary) without breaking the probe.

function reactSkeleton(args: BuildHarnessArgs): HarnessFile[] {
  const { toolchain, port } = args;
  const preact = toolchain.framework === "preact";
  const pluginImport = preact
    ? `import preact from "@preact/preset-vite";`
    : `import react from "@vitejs/plugin-react";`;
  const pluginUse = preact ? "preact()" : "react()";
  const dedupe = preact ? ["preact"] : ["react", "react-dom"];

  const main = `import React from "react";
import { createRoot } from "react-dom/client";
import { Gallery } from "./gallery.jsx";
${cssImportLines(args)}

createRoot(document.getElementById("root")).render(<Gallery />);
`;

  const errorBoundary = `import React from "react";

// Isolates one card's failure so a single un-renderable component doesn't blank
// the whole gallery — it shows the error inline instead.
export class CardErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <pre style={{ margin: 0, padding: 12, color: "#b91c1c", background: "#fef2f2", borderRadius: 8, whiteSpace: "pre-wrap", fontSize: 12 }}>
          {"Couldn't render: " + String(this.state.error?.message ?? this.state.error)}
        </pre>
      );
    }
    return this.props.children;
  }
}
`;

  const gallery = `import React from "react";
import { CardErrorBoundary } from "./ErrorBoundary.jsx";

const modules = import.meta.glob("./stories/*.{jsx,tsx}", { eager: true });

const stories = Object.entries(modules)
  .map(([file, mod]) => ({
    name: (mod && mod.title) || file.replace(/^\\.\\/stories\\//, "").replace(/\\.[jt]sx$/, ""),
    Component: mod && mod.default,
  }))
  .filter((s) => typeof s.Component === "function" || (s.Component && typeof s.Component === "object"))
  .sort((a, b) => a.name.localeCompare(b.name));

export function Gallery() {
  return (
    <div style={{ minHeight: "100vh", padding: 24, boxSizing: "border-box" }}>
      <header style={{ marginBottom: 20, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Component preview</div>
        <div style={{ fontSize: 13, opacity: 0.6 }}>
          {stories.length} component{stories.length === 1 ? "" : "s"} ${GALLERY_HEADER_NOTE}
        </div>
      </header>
      {stories.length === 0 && (
        <div style={{ opacity: 0.6, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
          No previewable components were generated for this change.
        </div>
      )}
      <div style={{ display: "grid", gap: 20 }}>
        {stories.map(({ name, Component }) => (
          <section key={name} style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
            <div style={{ padding: "8px 12px", fontSize: 12, fontWeight: 600, fontFamily: "ui-monospace, monospace", background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
              {name}
            </div>
            <div style={{ padding: 16 }}>
              <CardErrorBoundary>
                <Component />
              </CardErrorBoundary>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
`;

  return [
    {
      path: "package.json",
      content: harnessPackageJson(reactSkeletonDeps(preact)),
    },
    {
      path: "vite.config.js",
      content: viteConfig({
        appRoot: toolchain.appRoot,
        installRoot: toolchain.installRoot,
        port,
        pluginImport,
        pluginUse,
        dedupe,
        aliasEntries: resolveAliasEntries(args, []),
        postcssConfigDir: args.postcssConfigDir ?? null,
        // SSR verification needs react-dom/server; enable for React, not Preact.
        ssrRenderProbe: !preact,
      }),
    },
    { path: "index.html", content: indexHtml("/src/main.jsx") },
    { path: "src/main.jsx", content: main },
    { path: "src/gallery.jsx", content: gallery },
    { path: "src/ErrorBoundary.jsx", content: errorBoundary },
    // React-only: the SSR render-probe entry module (no-op for Preact, which
    // doesn't enable the probe — harmless extra file there).
    ...(preact ? [] : [{ path: RENDER_PROBE_MODULE, content: renderProbeEntryModule() }]),
  ];
}

function reactSkeletonDeps(preact: boolean): Record<string, string> {
  return preact
    ? { vite: "^5.4.0", "@preact/preset-vite": "^2.9.0" }
    : { vite: "^5.4.0", "@vitejs/plugin-react": "^4.3.0" };
}

// ── Solid ────────────────────────────────────────────────────────────────────

function solidSkeleton(args: BuildHarnessArgs): HarnessFile[] {
  const { toolchain, port } = args;
  const main = `import { render } from "solid-js/web";
import { Gallery } from "./gallery.jsx";
${cssImportLines(args)}

render(() => <Gallery />, document.getElementById("root"));
`;

  const gallery = `import { ErrorBoundary, For } from "solid-js";

const modules = import.meta.glob("./stories/*.{jsx,tsx}", { eager: true });

const stories = Object.entries(modules)
  .map(([file, mod]) => ({
    name: (mod && mod.title) || file.replace(/^\\.\\/stories\\//, "").replace(/\\.[jt]sx$/, ""),
    Component: mod && mod.default,
  }))
  .filter((s) => typeof s.Component === "function")
  .sort((a, b) => a.name.localeCompare(b.name));

export function Gallery() {
  return (
    <div style={{ "min-height": "100vh", padding: "24px", "box-sizing": "border-box" }}>
      <header style={{ "margin-bottom": "20px", "font-family": "ui-sans-serif, system-ui, sans-serif" }}>
        <div style={{ "font-size": "18px", "font-weight": 700 }}>Component preview</div>
        <div style={{ "font-size": "13px", opacity: 0.6 }}>
          {stories.length} component{stories.length === 1 ? "" : "s"} ${GALLERY_HEADER_NOTE}
        </div>
      </header>
      <div style={{ display: "grid", gap: "20px" }}>
        <For each={stories}>
          {({ name, Component }) => (
            <section style={{ border: "1px solid #e5e7eb", "border-radius": "12px", overflow: "hidden" }}>
              <div style={{ padding: "8px 12px", "font-size": "12px", "font-weight": 600, "font-family": "ui-monospace, monospace", background: "#f9fafb", "border-bottom": "1px solid #e5e7eb" }}>
                {name}
              </div>
              <div style={{ padding: "16px" }}>
                <ErrorBoundary fallback={(err) => (
                  <pre style={{ margin: 0, padding: "12px", color: "#b91c1c", background: "#fef2f2", "border-radius": "8px", "white-space": "pre-wrap", "font-size": "12px" }}>
                    {"Couldn't render: " + String(err?.message ?? err)}
                  </pre>
                )}>
                  <Component />
                </ErrorBoundary>
              </div>
            </section>
          )}
        </For>
      </div>
    </div>
  );
}
`;

  return [
    {
      path: "package.json",
      content: harnessPackageJson({ vite: "^5.4.0", "vite-plugin-solid": "^2.10.0" }),
    },
    {
      path: "vite.config.js",
      content: viteConfig({
        appRoot: toolchain.appRoot,
        installRoot: toolchain.installRoot,
        port,
        pluginImport: `import solid from "vite-plugin-solid";`,
        pluginUse: "solid()",
        dedupe: ["solid-js"],
        aliasEntries: resolveAliasEntries(args, []),
        postcssConfigDir: args.postcssConfigDir ?? null,
        ssrRenderProbe: false,
      }),
    },
    { path: "index.html", content: indexHtml("/src/main.jsx") },
    { path: "src/main.jsx", content: main },
    { path: "src/gallery.jsx", content: gallery },
  ];
}

// ── Vue ──────────────────────────────────────────────────────────────────────

function vueSkeleton(args: BuildHarnessArgs): HarnessFile[] {
  const { toolchain, port } = args;
  const main = `import { createApp } from "vue";
import Gallery from "./Gallery.vue";
${cssImportLines(args)}

createApp(Gallery).mount("#root");
`;

  const card = `<script>
export default {
  props: { name: String, comp: [Object, Function] },
  data() {
    return { error: null };
  },
  errorCaptured(err) {
    this.error = err;
    return false;
  },
};
</script>

<template>
  <section :style="{ border: '1px solid #e5e7eb', borderRadius: '12px', overflow: 'hidden' }">
    <div :style="{ padding: '8px 12px', fontSize: '12px', fontWeight: 600, fontFamily: 'ui-monospace, monospace', background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }">
      {{ name }}
    </div>
    <div :style="{ padding: '16px' }">
      <pre v-if="error" :style="{ margin: 0, padding: '12px', color: '#b91c1c', background: '#fef2f2', borderRadius: '8px', whiteSpace: 'pre-wrap', fontSize: '12px' }">{{ "Couldn't render: " + String(error && error.message || error) }}</pre>
      <component v-else :is="comp" />
    </div>
  </section>
</template>
`;

  const gallery = `<script>
const modules = import.meta.glob("./stories/*.{vue,js,ts,jsx,tsx}", { eager: true });
const stories = Object.entries(modules)
  .map(([file, mod]) => ({
    name: (mod && mod.title) || file.replace(/^\\.\\/stories\\//, "").replace(/\\.[a-z]+$/i, ""),
    comp: mod && mod.default,
  }))
  .filter((s) => s.comp)
  .sort((a, b) => a.name.localeCompare(b.name));

import Card from "./Card.vue";
export default {
  components: { Card },
  data() {
    return { stories };
  },
};
</script>

<template>
  <div :style="{ minHeight: '100vh', padding: '24px', boxSizing: 'border-box' }">
    <header :style="{ marginBottom: '20px', fontFamily: 'ui-sans-serif, system-ui, sans-serif' }">
      <div :style="{ fontSize: '18px', fontWeight: 700 }">Component preview</div>
      <div :style="{ fontSize: '13px', opacity: 0.6 }">
        {{ stories.length }} component{{ stories.length === 1 ? "" : "s" }} ${GALLERY_HEADER_NOTE}
      </div>
    </header>
    <div :style="{ display: 'grid', gap: '20px' }">
      <Card v-for="s in stories" :key="s.name" :name="s.name" :comp="s.comp" />
    </div>
  </div>
</template>
`;

  return [
    {
      path: "package.json",
      content: harnessPackageJson({ vite: "^5.4.0", "@vitejs/plugin-vue": "^5.1.0" }),
    },
    {
      path: "vite.config.js",
      content: viteConfig({
        appRoot: toolchain.appRoot,
        installRoot: toolchain.installRoot,
        port,
        pluginImport: `import vue from "@vitejs/plugin-vue";`,
        pluginUse: "vue()",
        dedupe: ["vue"],
        aliasEntries: resolveAliasEntries(args, []),
        postcssConfigDir: args.postcssConfigDir ?? null,
        ssrRenderProbe: false,
      }),
    },
    { path: "index.html", content: indexHtml("/src/main.js") },
    { path: "src/main.js", content: main },
    { path: "src/Gallery.vue", content: gallery },
    { path: "src/Card.vue", content: card },
  ];
}

// ── Svelte ───────────────────────────────────────────────────────────────────

function svelteSkeleton(args: BuildHarnessArgs): HarnessFile[] {
  const { toolchain, port } = args;
  // Svelte 5's `mount` API; on Svelte 4 the template self-heals via the LLM
  // fall-through when this fails to start.
  const main = `import { mount } from "svelte";
import Gallery from "./Gallery.svelte";
${cssImportLines(args)}

mount(Gallery, { target: document.getElementById("root") });
`;

  const gallery = `<script>
  const modules = import.meta.glob("./stories/*.svelte", { eager: true });
  const stories = Object.entries(modules)
    .map(([file, mod]) => ({
      name: file.replace(/^\\.\\/stories\\//, "").replace(/\\.svelte$/, ""),
      Component: mod && mod.default,
    }))
    .filter((s) => s.Component)
    .sort((a, b) => a.name.localeCompare(b.name));
</script>

<div style="min-height:100vh;padding:24px;box-sizing:border-box;">
  <header style="margin-bottom:20px;font-family:ui-sans-serif, system-ui, sans-serif;">
    <div style="font-size:18px;font-weight:700;">Component preview</div>
    <div style="font-size:13px;opacity:0.6;">
      {stories.length} component{stories.length === 1 ? "" : "s"} ${GALLERY_HEADER_NOTE}
    </div>
  </header>
  <div style="display:grid;gap:20px;">
    {#each stories as { name, Component } (name)}
      <section style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
        <div style="padding:8px 12px;font-size:12px;font-weight:600;font-family:ui-monospace, monospace;background:#f9fafb;border-bottom:1px solid #e5e7eb;">
          {name}
        </div>
        <div style="padding:16px;">
          <svelte:boundary>
            <svelte:component this={Component} />
            {#snippet failed(error)}
              <pre style="margin:0;padding:12px;color:#b91c1c;background:#fef2f2;border-radius:8px;white-space:pre-wrap;font-size:12px;">{"Couldn't render: " + String(error && error.message || error)}</pre>
            {/snippet}
          </svelte:boundary>
        </div>
      </section>
    {/each}
  </div>
</div>
`;

  return [
    {
      path: "package.json",
      content: harnessPackageJson({
        vite: "^5.4.0",
        "@sveltejs/vite-plugin-svelte": "^4.0.0",
      }),
    },
    {
      path: "vite.config.js",
      content: viteConfig({
        appRoot: toolchain.appRoot,
        installRoot: toolchain.installRoot,
        port,
        pluginImport: `import { svelte } from "@sveltejs/vite-plugin-svelte";`,
        pluginUse: "svelte()",
        dedupe: ["svelte"],
        aliasEntries: resolveAliasEntries(args, []),
        postcssConfigDir: args.postcssConfigDir ?? null,
        ssrRenderProbe: false,
      }),
    },
    { path: "index.html", content: indexHtml("/src/main.js") },
    { path: "src/main.js", content: main },
    { path: "src/Gallery.svelte", content: gallery },
  ];
}

// ── Registry ───────────────────────────────────────────────────────────────────

const FRAMEWORK_TEMPLATES: Record<FrontendFramework, FrameworkTemplate> = {
  react: {
    componentExtensions: [".tsx", ".jsx"],
    devDependencies: reactSkeletonDeps(false),
    buildSkeleton: reactSkeleton,
  },
  preact: {
    componentExtensions: [".tsx", ".jsx"],
    devDependencies: reactSkeletonDeps(true),
    buildSkeleton: reactSkeleton,
  },
  solid: {
    componentExtensions: [".tsx", ".jsx"],
    devDependencies: { vite: "^5.4.0", "vite-plugin-solid": "^2.10.0" },
    buildSkeleton: solidSkeleton,
  },
  vue: {
    componentExtensions: [".vue"],
    devDependencies: { vite: "^5.4.0", "@vitejs/plugin-vue": "^5.1.0" },
    buildSkeleton: vueSkeleton,
  },
  svelte: {
    componentExtensions: [".svelte"],
    devDependencies: { vite: "^5.4.0", "@sveltejs/vite-plugin-svelte": "^4.0.0" },
    buildSkeleton: svelteSkeleton,
  },
};

/** Whether a deterministic template exists for this framework. */
export function hasTemplate(framework: FrontendFramework): boolean {
  return Object.hasOwn(FRAMEWORK_TEMPLATES, framework);
}

/** Source extensions this framework renders as standalone story cards. */
export function componentExtensionsFor(framework: FrontendFramework): string[] {
  return FRAMEWORK_TEMPLATES[framework].componentExtensions;
}

/**
 * Build the harness skeleton (everything except per-component stories, generated
 * separately under `stories/`) for the toolchain's framework. Pure.
 */
export function buildHarnessFiles(args: BuildHarnessArgs): HarnessFile[] {
  return FRAMEWORK_TEMPLATES[args.toolchain.framework].buildSkeleton(args);
}

/** The npm dependency name of a framework's runtime (for alias resolution). */
export function runtimePackageName(framework: FrontendFramework): string {
  switch (framework) {
    case "react":
      return "react";
    case "preact":
      return "preact";
    case "vue":
      return "vue";
    case "svelte":
      return "svelte";
    case "solid":
      return "solid-js";
  }
}

// Re-export the framework-aware story builder so the caller has one import site.
export { buildStoryFor };
