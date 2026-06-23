import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectFrontendToolchain,
  findPostcssConfigDir,
  readTsconfigAliases,
  resolveFrontendToolchain,
} from "../src/toolchain.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolchain-test-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const dest = path.join(dir, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, content, "utf8");
}

async function pkg(obj: Record<string, unknown>): Promise<void> {
  await write("package.json", JSON.stringify(obj));
}

describe("detectFrontendToolchain", () => {
  it("returns null when there's no package.json", async () => {
    expect(await detectFrontendToolchain(dir)).toBeNull();
  });

  it("returns null for an unrecognized framework", async () => {
    await pkg({ dependencies: { "@angular/core": "^18.0.0" } });
    expect(await detectFrontendToolchain(dir)).toBeNull();
  });

  it("requires both react and react-dom for react (but falls through to others)", async () => {
    await pkg({ dependencies: { react: "^18.0.0" } });
    expect(await detectFrontendToolchain(dir)).toBeNull();
  });

  it("detects a React project", async () => {
    await pkg({ dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" } });
    const tc = await detectFrontendToolchain(dir);
    expect(tc?.framework).toBe("react");
  });

  it("detects Vue / Svelte / Solid / Preact", async () => {
    await pkg({ dependencies: { vue: "^3.0.0" } });
    expect((await detectFrontendToolchain(dir))?.framework).toBe("vue");
    await pkg({ dependencies: { svelte: "^5.0.0" } });
    expect((await detectFrontendToolchain(dir))?.framework).toBe("svelte");
    await pkg({ dependencies: { "solid-js": "^1.8.0" } });
    expect((await detectFrontendToolchain(dir))?.framework).toBe("solid");
    await pkg({ dependencies: { preact: "^10.0.0" } });
    expect((await detectFrontendToolchain(dir))?.framework).toBe("preact");
  });

  it("reports appRoot and installRoot at the detected dir", async () => {
    await pkg({ dependencies: { react: "^18", "react-dom": "^18" } });
    const tc = await detectFrontendToolchain(dir);
    expect(tc?.appRoot).toBe(dir);
    expect(tc?.installRoot).toBe(dir);
  });

  it("detects TypeScript via tsconfig.json", async () => {
    await pkg({ dependencies: { react: "^18", "react-dom": "^18" } });
    await write("tsconfig.json", "{}");
    const tc = await detectFrontendToolchain(dir);
    expect(tc?.language).toBe("ts");
    expect(tc?.tsconfigPath).toBe("tsconfig.json");
  });

  it("falls back to js when there's no tsconfig or typescript dep", async () => {
    await pkg({ dependencies: { react: "^18", "react-dom": "^18" } });
    const tc = await detectFrontendToolchain(dir);
    expect(tc?.language).toBe("js");
    expect(tc?.tsconfigPath).toBeNull();
  });

  it("detects the package manager from the lockfile", async () => {
    await pkg({ dependencies: { react: "^18", "react-dom": "^18" } });
    await write("pnpm-lock.yaml", "");
    expect((await detectFrontendToolchain(dir))?.packageManager).toBe("pnpm");
  });

  it("defaults the package manager to npm", async () => {
    await pkg({ dependencies: { react: "^18", "react-dom": "^18" } });
    expect((await detectFrontendToolchain(dir))?.packageManager).toBe("npm");
  });

  it("collects the global stylesheets that exist", async () => {
    await pkg({ dependencies: { react: "^18", "react-dom": "^18" } });
    await write("src/index.css", "");
    await write("src/styles/globals.css", "");
    const tc = await detectFrontendToolchain(dir);
    expect(tc?.globalCss).toContain("src/index.css");
    expect(tc?.globalCss).toContain("src/styles/globals.css");
  });

  it("detects Tailwind via dependency", async () => {
    await pkg({
      dependencies: { react: "^18", "react-dom": "^18" },
      devDependencies: { tailwindcss: "^3" },
    });
    expect((await detectFrontendToolchain(dir))?.hasTailwind).toBe(true);
  });

  it("detects Tailwind via a config file", async () => {
    await pkg({ dependencies: { react: "^18", "react-dom": "^18" } });
    await write("tailwind.config.ts", "export default {}");
    expect((await detectFrontendToolchain(dir))?.hasTailwind).toBe(true);
  });
});

describe("resolveFrontendToolchain (repo-agnostic)", () => {
  it("finds a frontend app nested in a monorepo subdirectory", async () => {
    // Root is NOT a frontend app — it's a workspace root.
    await write(
      "package.json",
      JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] }),
    );
    await write("pnpm-workspace.yaml", "packages:\n  - apps/*\n");
    // The actual frontend lives in apps/web.
    await write(
      "apps/web/package.json",
      JSON.stringify({ dependencies: { react: "^18", "react-dom": "^18" } }),
    );
    const component = path.join(dir, "apps/web/src/components/Button.tsx");
    await write("apps/web/src/components/Button.tsx", "export default function Button() {}");

    const tc = await resolveFrontendToolchain(dir, [component]);
    expect(tc?.framework).toBe("react");
    expect(tc?.appRoot).toBe(path.join(dir, "apps/web"));
    // Deps install from the workspace root so hoisted packages resolve.
    expect(tc?.installRoot).toBe(dir);
  });

  it("picks the app that owns the most changed components", async () => {
    await write("package.json", JSON.stringify({ private: true, workspaces: ["apps/*"] }));
    await write("apps/web/package.json", JSON.stringify({ dependencies: { vue: "^3" } }));
    await write(
      "apps/admin/package.json",
      JSON.stringify({ dependencies: { react: "^18", "react-dom": "^18" } }),
    );
    await write("apps/web/src/A.vue", "");
    await write("apps/web/src/B.vue", "");
    await write("apps/admin/src/C.tsx", "export default function C() {}");

    const tc = await resolveFrontendToolchain(dir, [
      path.join(dir, "apps/web/src/A.vue"),
      path.join(dir, "apps/web/src/B.vue"),
      path.join(dir, "apps/admin/src/C.tsx"),
    ]);
    expect(tc?.framework).toBe("vue");
    expect(tc?.appRoot).toBe(path.join(dir, "apps/web"));
  });

  it("scans for an app when no changed component sits under a framework package", async () => {
    await write("package.json", JSON.stringify({ private: true }));
    await write("frontend/package.json", JSON.stringify({ dependencies: { svelte: "^5" } }));
    // Changed file is outside any framework package.
    const tc = await resolveFrontendToolchain(dir, [path.join(dir, "docs/readme.tsx")]);
    expect(tc?.framework).toBe("svelte");
    expect(tc?.appRoot).toBe(path.join(dir, "frontend"));
  });

  it("returns null when the repo declares no recognized framework", async () => {
    await write("package.json", JSON.stringify({ dependencies: { express: "^4" } }));
    expect(await resolveFrontendToolchain(dir, [path.join(dir, "src/x.tsx")])).toBeNull();
  });
});

describe("readTsconfigAliases", () => {
  it("translates tsconfig paths (any scheme) to absolute aliases", async () => {
    await write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["src/*"], "~components/*": ["src/components/*"] },
        },
      }),
    );
    const aliases = await readTsconfigAliases(dir, dir);
    expect(aliases).toContainEqual({ find: "@", replacement: path.join(dir, "src") });
    expect(aliases).toContainEqual({
      find: "~components",
      replacement: path.join(dir, "src/components"),
    });
  });

  it("tolerates a JSONC tsconfig (comments + trailing commas)", async () => {
    await write(
      "tsconfig.json",
      '{\n  // app config\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": { "@/*": ["app/*"], },\n  },\n}',
    );
    const aliases = await readTsconfigAliases(dir, dir);
    expect(aliases).toContainEqual({ find: "@", replacement: path.join(dir, "app") });
  });

  it("returns [] when there is no tsconfig or no paths", async () => {
    expect(await readTsconfigAliases(dir, dir)).toEqual([]);
    await write("tsconfig.json", JSON.stringify({ compilerOptions: {} }));
    expect(await readTsconfigAliases(dir, dir)).toEqual([]);
  });
});

describe("findPostcssConfigDir", () => {
  it("finds a postcss config at the app root", async () => {
    await write("postcss.config.js", "module.exports = {}");
    expect(await findPostcssConfigDir(dir, dir)).toBe(dir);
  });

  it("finds a postcss config at a workspace root above the app", async () => {
    await write("postcss.config.cjs", "module.exports = {}");
    await write("apps/web/package.json", JSON.stringify({ dependencies: { react: "^18" } }));
    const appRoot = path.join(dir, "apps/web");
    expect(await findPostcssConfigDir(appRoot, dir)).toBe(dir);
  });

  it("detects a postcss key in package.json", async () => {
    await write("package.json", JSON.stringify({ postcss: { plugins: {} } }));
    expect(await findPostcssConfigDir(dir, dir)).toBe(dir);
  });

  it("returns null when there's no postcss config", async () => {
    await write("package.json", JSON.stringify({ dependencies: {} }));
    expect(await findPostcssConfigDir(dir, dir)).toBeNull();
  });
});
