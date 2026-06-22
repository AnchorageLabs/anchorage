import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectFrontendToolchain } from "../src/toolchain.js";

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

  it("returns null for a non-React project", async () => {
    await pkg({ dependencies: { vue: "^3.0.0" } });
    expect(await detectFrontendToolchain(dir)).toBeNull();
  });

  it("requires both react and react-dom", async () => {
    await pkg({ dependencies: { react: "^18.0.0" } });
    expect(await detectFrontendToolchain(dir)).toBeNull();
  });

  it("detects a React project", async () => {
    await pkg({ dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" } });
    const tc = await detectFrontendToolchain(dir);
    expect(tc?.framework).toBe("react");
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
