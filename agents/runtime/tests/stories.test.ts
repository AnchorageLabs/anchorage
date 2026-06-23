import { describe, expect, it } from "vitest";
import {
  buildFallbackStory,
  buildStoryFor,
  componentTitle,
  detectExport,
  isRenderableComponent,
} from "../src/stories.js";

describe("isRenderableComponent", () => {
  it("accepts tsx/jsx/vue/svelte", () => {
    expect(isRenderableComponent("/repo/src/Button.tsx")).toBe(true);
    expect(isRenderableComponent("/repo/src/Button.jsx")).toBe(true);
    expect(isRenderableComponent("/repo/src/Button.vue")).toBe(true);
    expect(isRenderableComponent("/repo/src/Button.svelte")).toBe(true);
  });
  it("rejects styles/assets/other", () => {
    expect(isRenderableComponent("/repo/src/app.css")).toBe(false);
    expect(isRenderableComponent("/repo/src/util.ts")).toBe(false);
    expect(isRenderableComponent("/repo/public/logo.svg")).toBe(false);
  });
});

describe("componentTitle", () => {
  it("derives a title from the file name (any framework extension)", () => {
    expect(componentTitle("/repo/src/components/Button.tsx")).toBe("Button");
    expect(componentTitle("/repo/src/components/Button.vue")).toBe("Button");
    expect(componentTitle("/repo/src/components/Button.svelte")).toBe("Button");
  });
});

describe("buildStoryFor", () => {
  it("builds a JSX story for react", () => {
    const story = buildStoryFor("react", {
      absPath: "/repo/src/Card.tsx",
      source: "export default function Card() { return null; }",
    });
    expect(story?.fileName).toBe("Card.story.jsx");
    expect(story?.content).toContain('import Component from "/repo/src/Card.tsx";');
  });

  it("builds a JSX story for solid", () => {
    const story = buildStoryFor("solid", {
      absPath: "/repo/src/Card.tsx",
      source: "export default function Card() { return null; }",
    });
    expect(story?.fileName).toBe("Card.story.jsx");
  });

  it("re-exports the SFC for vue", () => {
    const story = buildStoryFor("vue", { absPath: "/repo/src/Card.vue", source: "" });
    expect(story?.fileName).toBe("Card.story.js");
    expect(story?.content).toContain('export { default } from "/repo/src/Card.vue";');
  });

  it("wraps the component for svelte", () => {
    const story = buildStoryFor("svelte", { absPath: "/repo/src/Card.svelte", source: "" });
    expect(story?.fileName).toBe("Card.story.svelte");
    expect(story?.content).toContain('import Component from "/repo/src/Card.svelte";');
    expect(story?.content).toContain("<Component />");
  });
});

describe("detectExport", () => {
  it("detects a default export", () => {
    expect(detectExport("export default function Button() {}")).toEqual({ kind: "default" });
    expect(detectExport("const X = () => null;\nexport default X;")).toEqual({ kind: "default" });
  });
  it("detects a named function component", () => {
    expect(detectExport("export function Card() { return null; }")).toEqual({
      kind: "named",
      name: "Card",
    });
  });
  it("detects a named const component", () => {
    expect(detectExport("export const Avatar = () => null;")).toEqual({
      kind: "named",
      name: "Avatar",
    });
  });
  it("detects a re-export list", () => {
    expect(detectExport("function Modal() {}\nexport { Modal };")).toEqual({
      kind: "named",
      name: "Modal",
    });
  });
  it("returns null when there's no component-looking export", () => {
    expect(detectExport("export const helperValue = 3;")).toBeNull();
    expect(detectExport("const Internal = () => null;")).toBeNull();
  });
});

describe("buildFallbackStory", () => {
  it("imports a default export and renders it", () => {
    const story = buildFallbackStory({
      absPath: "/repo/src/Button.tsx",
      source: "export default function Button() { return null; }",
    });
    expect(story).not.toBeNull();
    expect(story?.fileName).toBe("Button.story.jsx");
    expect(story?.content).toContain('import Component from "/repo/src/Button.tsx";');
    expect(story?.content).toContain('export const title = "Button";');
    expect(story?.content).toContain("<Component />");
  });

  it("imports a named export under the Component alias", () => {
    const story = buildFallbackStory({
      absPath: "/repo/src/Card.tsx",
      source: "export function Card() { return null; }",
    });
    expect(story?.content).toContain('import { Card as Component } from "/repo/src/Card.tsx";');
  });

  it("returns null when no component export is detectable", () => {
    expect(
      buildFallbackStory({ absPath: "/repo/src/x.tsx", source: "export const k = 1;" }),
    ).toBeNull();
  });
});
