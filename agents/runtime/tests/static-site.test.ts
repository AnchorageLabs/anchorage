import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectStaticSiteFor } from "../src/index.js";

// Builds a throwaway workspace with the given files (relative path -> contents)
// so detectStaticSiteFor can be exercised against a real directory tree.
async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-static-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
  return root;
}

describe("detectStaticSiteFor", () => {
  let workspace: string | null = null;

  afterEach(async () => {
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
    workspace = null;
  });

  it("serves the nearest folder for a nested static-site monorepo (the teramot-landing case)", async () => {
    workspace = await makeWorkspace({
      "README.md": "# sites",
      "sites/go/index.html": "<title>go</title>",
      "sites/landing/index.html": "<title>landing</title>",
      "sites/landing/features.jsx": "const X = () => null;",
    });

    // A .jsx change opens the folder's index.html (the page that loads it).
    const jsx = await detectStaticSiteFor(workspace, ["sites/landing/features.jsx"]);
    expect(jsx).toEqual({
      serveDir: path.join(workspace, "sites", "landing"),
      openPath: "index.html",
    });

    // An HTML change opens that exact page.
    const html = await detectStaticSiteFor(workspace, ["sites/go/index.html"]);
    expect(html).toEqual({
      serveDir: path.join(workspace, "sites", "go"),
      openPath: "index.html",
    });
  });

  it("opens the changed HTML page itself when it is not the index", async () => {
    workspace = await makeWorkspace({
      "sites/landing/index.html": "<title>home</title>",
      "sites/landing/pricing.html": "<title>pricing</title>",
    });

    const result = await detectStaticSiteFor(workspace, ["sites/landing/pricing.html"]);
    expect(result).toEqual({
      serveDir: path.join(workspace, "sites", "landing"),
      openPath: "pricing.html",
    });
  });

  it("falls back to a root index.html when the changed file has no nearer page", async () => {
    workspace = await makeWorkspace({
      "index.html": "<title>root</title>",
      "css/app.css": "body{}",
    });

    const result = await detectStaticSiteFor(workspace, ["css/app.css"]);
    expect(result).toEqual({ serveDir: workspace, openPath: "index.html" });
  });

  it("returns null when there is no index.html to serve", async () => {
    workspace = await makeWorkspace({ "src/Button.tsx": "export const B = () => null;" });
    expect(await detectStaticSiteFor(workspace, ["src/Button.tsx"])).toBeNull();
  });
});
