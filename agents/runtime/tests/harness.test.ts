import { describe, expect, it } from "vitest";
import { buildHarnessFiles, STORIES_DIR } from "../src/harness.js";
import type { FrontendToolchain } from "../src/toolchain.js";

const toolchain: FrontendToolchain = {
  framework: "react",
  language: "ts",
  packageManager: "pnpm",
  appRoot: "/repo",
  installRoot: "/repo",
  globalCss: ["src/index.css", "src/styles/globals.css"],
  hasTailwind: true,
  tsconfigPath: "tsconfig.json",
};

function files() {
  return buildHarnessFiles({
    toolchain,
    port: 3101,
    frameworkDir: "/repo/node_modules/react",
    reactDomDir: "/repo/node_modules/react-dom",
  });
}

describe("buildHarnessFiles (react)", () => {
  it("emits the harness skeleton files", () => {
    const paths = files()
      .map((f) => f.path)
      .sort();
    expect(paths).toEqual(
      [
        "index.html",
        "package.json",
        "src/ErrorBoundary.jsx",
        "src/__anchorage_probe.jsx",
        "src/gallery.jsx",
        "src/main.jsx",
        "vite.config.js",
      ].sort(),
    );
  });

  it("declares vite + react plugin in dependencies (survives NODE_ENV=production)", () => {
    const pkg = JSON.parse(files().find((f) => f.path === "package.json")?.content ?? "{}");
    expect(Object.keys(pkg.dependencies)).toEqual(["vite", "@vitejs/plugin-react"]);
    expect(pkg.devDependencies).toBeUndefined();
  });

  it("dedupes react to the app's copy and binds the configured port", () => {
    const cfg = files().find((f) => f.path === "vite.config.js")?.content ?? "";
    expect(cfg).toContain('dedupe: ["react","react-dom"]');
    // react/react-dom are pinned via dedupe, NOT an absolute-path alias — an
    // alias would break the SSR render probe's externalization of react.
    expect(cfg).not.toContain('{ find: "react",');
    expect(cfg).not.toContain('{ find: "react-dom",');
    expect(cfg).toContain("port: 3101");
    expect(cfg).toContain('const appRoot = "/repo";');
  });

  it("falls back to a default @ -> src alias when the app declares none", () => {
    const cfg = files().find((f) => f.path === "vite.config.js")?.content ?? "";
    expect(cfg).toContain('{ find: "@", replacement: "/repo/src" }');
  });

  it("isolates PostCSS by default so the app's config is never auto-loaded", () => {
    const cfg = files().find((f) => f.path === "vite.config.js")?.content ?? "";
    expect(cfg).toContain("postcss: { plugins: [] }");
  });

  it("points PostCSS at the app's config dir when one exists", () => {
    const cfg =
      buildHarnessFiles({
        toolchain,
        port: 3101,
        frameworkDir: "/repo/node_modules/react",
        reactDomDir: "/repo/node_modules/react-dom",
        postcssConfigDir: "/repo",
      }).find((f) => f.path === "vite.config.js")?.content ?? "";
    expect(cfg).toContain('postcss: "/repo"');
  });

  it("maps the app's declared aliases (any scheme) to absolute paths", () => {
    const cfg =
      buildHarnessFiles({
        toolchain,
        port: 3101,
        frameworkDir: null,
        aliasEntries: [{ find: "~", replacement: "/repo/source" }],
      }).find((f) => f.path === "vite.config.js")?.content ?? "";
    expect(cfg).toContain('{ find: "~", replacement: "/repo/source" }');
  });

  it("allows Vite to read sources from the app + install roots, not just the harness", () => {
    const cfg = files().find((f) => f.path === "vite.config.js")?.content ?? "";
    expect(cfg).toContain("fs: { allow: [__dirname, appRoot, installRoot] }");
  });

  it("imports each global stylesheet by absolute path for fidelity", () => {
    const main = files().find((f) => f.path === "src/main.jsx")?.content ?? "";
    expect(main).toContain('import "/repo/src/index.css";');
    expect(main).toContain('import "/repo/src/styles/globals.css";');
  });

  it("auto-discovers stories via import.meta.glob", () => {
    const gallery = files().find((f) => f.path === "src/gallery.jsx")?.content ?? "";
    expect(gallery).toContain("import.meta.glob");
    expect(gallery).toContain("./stories/");
  });

  it("places stories under the harness src dir", () => {
    expect(STORIES_DIR).toBe("src/stories");
  });

  it("adds the SSR render-probe route + entry module so render failures are detectable without a browser", () => {
    const all = files();
    const cfg = all.find((f) => f.path === "vite.config.js")?.content ?? "";
    expect(cfg).toContain("anchorageRenderProbe()");
    expect(cfg).toContain("/__anchorage/render");
    // react/react-dom MUST be SSR-external or Vite evaluates their CJS as ESM and
    // the probe silently returns nothing.
    expect(cfg).toContain('external: ["react", "react-dom"]');

    const probe = all.find((f) => f.path === "src/__anchorage_probe.jsx")?.content ?? "";
    expect(probe).toContain("renderToStaticMarkup");
    // The probe renders the STORIES, never the app entry point.
    expect(probe).toContain('import.meta.glob("./stories/*.{jsx,tsx}")');
    expect(probe).toContain("runProbe");
  });
});

describe("buildHarnessFiles (other frameworks)", () => {
  function harnessFor(framework: FrontendToolchain["framework"]) {
    return buildHarnessFiles({
      toolchain: { ...toolchain, framework },
      port: 3101,
      frameworkDir: null,
    });
  }

  it("builds a Vue harness with the vue plugin and SFC gallery", () => {
    const f = harnessFor("vue");
    const pkg = JSON.parse(f.find((x) => x.path === "package.json")?.content ?? "{}");
    expect(Object.keys(pkg.dependencies)).toContain("@vitejs/plugin-vue");
    expect(f.map((x) => x.path)).toContain("src/Gallery.vue");
    const cfg = f.find((x) => x.path === "vite.config.js")?.content ?? "";
    expect(cfg).toContain('dedupe: ["vue"]');
  });

  it("builds a Svelte harness with the svelte plugin", () => {
    const f = harnessFor("svelte");
    const pkg = JSON.parse(f.find((x) => x.path === "package.json")?.content ?? "{}");
    expect(Object.keys(pkg.dependencies)).toContain("@sveltejs/vite-plugin-svelte");
    expect(f.map((x) => x.path)).toContain("src/Gallery.svelte");
  });

  it("builds a Solid harness with the solid plugin", () => {
    const f = harnessFor("solid");
    const pkg = JSON.parse(f.find((x) => x.path === "package.json")?.content ?? "{}");
    expect(Object.keys(pkg.dependencies)).toContain("vite-plugin-solid");
    const cfg = f.find((x) => x.path === "vite.config.js")?.content ?? "";
    expect(cfg).toContain('dedupe: ["solid-js"]');
  });

  it("does not add the React-only SSR render probe to non-React harnesses", () => {
    for (const framework of ["vue", "svelte", "solid", "preact"] as const) {
      const cfg = harnessFor(framework).find((x) => x.path === "vite.config.js")?.content ?? "";
      expect(cfg).not.toContain("anchorageRenderProbe");
    }
  });
});
