import { describe, expect, it } from "vitest";
import { classifyChange } from "../src/classify.js";

describe("classifyChange", () => {
  it("treats a docs-only change as docs", () => {
    expect(classifyChange(["README.md", "docs/guide.mdx", "CHANGELOG.md"])).toBe("docs");
  });

  it("treats a pure UI change as visual", () => {
    expect(classifyChange(["src/components/Button.tsx", "src/styles/app.css"])).toBe("visual");
  });

  it("treats a CSS-only change as visual", () => {
    expect(classifyChange(["app/globals.scss"])).toBe("visual");
  });

  it("ignores docs when deciding a visual change", () => {
    expect(classifyChange(["README.md", "src/Card.tsx"])).toBe("visual");
  });

  it("treats a backend change as backend", () => {
    expect(classifyChange(["src/server/db.ts", "src/lib/util.ts"])).toBe("backend");
  });

  it("treats a mixed UI + API-route change as backend (backend wins)", () => {
    expect(classifyChange(["src/components/Button.tsx", "src/app/api/users/route.ts"])).toBe(
      "backend",
    );
  });

  it("detects backend by path even for a .tsx under api/", () => {
    expect(classifyChange(["src/api/handlers/list.tsx"])).toBe("backend");
  });

  it("detects non-JS backend languages", () => {
    expect(classifyChange(["service/main.py"])).toBe("backend");
    expect(classifyChange(["cmd/server/main.go"])).toBe("backend");
  });

  it("detects SQL/migrations as backend", () => {
    expect(classifyChange(["migrations/020_add_col.sql"])).toBe("backend");
  });

  it("treats config/tooling-only changes as non-visual", () => {
    expect(classifyChange(["tsconfig.json", "src/lib/format.ts"])).toBe("non-visual");
  });

  it("treats an empty change set as docs (nothing meaningful)", () => {
    expect(classifyChange([])).toBe("docs");
  });

  it("treats image/asset changes as visual", () => {
    expect(classifyChange(["public/logo.svg"])).toBe("visual");
  });

  it("treats Vue and Svelte single-file components as visual", () => {
    expect(classifyChange(["src/App.vue"])).toBe("visual");
    expect(classifyChange(["src/Widget.svelte"])).toBe("visual");
  });
});
