import { describe, expect, it } from "vitest";
import { buildHarnessFiles, STORIES_DIR } from "../src/harness.js";
import type { FrontendToolchain } from "../src/toolchain.js";

const toolchain: FrontendToolchain = {
  framework: "react",
  language: "ts",
  packageManager: "pnpm",
  globalCss: ["src/index.css", "src/styles/globals.css"],
  hasTailwind: true,
  tsconfigPath: "tsconfig.json",
};

function files() {
  return buildHarnessFiles({ toolchain, workspacePath: "/repo", port: 3101 });
}

describe("buildHarnessFiles", () => {
  it("emits the harness skeleton files", () => {
    const paths = files()
      .map((f) => f.path)
      .sort();
    expect(paths).toEqual(
      [
        "index.html",
        "package.json",
        "src/ErrorBoundary.jsx",
        "src/gallery.jsx",
        "src/main.jsx",
        "vite.config.js",
      ].sort(),
    );
  });

  it("only depends on vite + react plugin (react comes from the repo)", () => {
    const pkg = JSON.parse(files().find((f) => f.path === "package.json")?.content ?? "{}");
    expect(Object.keys(pkg.devDependencies)).toEqual(["vite", "@vitejs/plugin-react"]);
    expect(pkg.dependencies).toBeUndefined();
  });

  it("dedupes react to the repo's copy and binds the configured port", () => {
    const cfg = files().find((f) => f.path === "vite.config.js")?.content ?? "";
    expect(cfg).toContain('dedupe: ["react", "react-dom"]');
    expect(cfg).toContain('path.join(repo, "node_modules/react")');
    expect(cfg).toContain("port: 3101");
    expect(cfg).toContain('const repo = "/repo";');
  });

  it("allows Vite to read sources from the repo, not just the harness", () => {
    const cfg = files().find((f) => f.path === "vite.config.js")?.content ?? "";
    expect(cfg).toContain("fs: { allow: [__dirname, repo] }");
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
});
