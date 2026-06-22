import { describe, expect, it } from "vitest";
import {
  buildFallbackStory,
  componentTitle,
  detectExport,
  isRenderableComponent,
  storyFileName,
} from "../src/stories.js";

describe("isRenderableComponent", () => {
  it("accepts tsx/jsx", () => {
    expect(isRenderableComponent("/repo/src/Button.tsx")).toBe(true);
    expect(isRenderableComponent("/repo/src/Button.jsx")).toBe(true);
  });
  it("rejects styles/assets/other", () => {
    expect(isRenderableComponent("/repo/src/app.css")).toBe(false);
    expect(isRenderableComponent("/repo/src/util.ts")).toBe(false);
    expect(isRenderableComponent("/repo/public/logo.svg")).toBe(false);
  });
});

describe("componentTitle / storyFileName", () => {
  it("derives a title from the file name", () => {
    expect(componentTitle("/repo/src/components/Button.tsx")).toBe("Button");
  });
  it("builds a .story.jsx filename", () => {
    expect(storyFileName("/repo/src/Card.tsx")).toBe("Card.story.jsx");
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
