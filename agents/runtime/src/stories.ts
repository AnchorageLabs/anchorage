// Generates the per-component "stories" the gallery renders. A story is a tiny
// module that renders one changed component in isolation, with no props, inside
// the gallery's per-card error boundary. Each framework has its own story shape
// (JSX for React/Preact/Solid, an SFC re-export for Vue, a wrapper for Svelte),
// but the contract is identical: discoverable by the gallery's import.meta.glob,
// default-exporting something the framework can render.
//
// Stories deliberately pass NO props — presentational/prop-optional components
// preview faithfully; components that require props/context show their error in
// the card. (LLM-synthesized stories with realistic mock props are the general
// path's job.)

import path from "node:path";
import type { FrontendFramework } from "./toolchain.js";

export interface ComponentEntry {
  /** Absolute path to the changed component source file. */
  absPath: string;
  /** The file's source, used to detect how the component is exported. */
  source: string;
}

export interface StoryFile {
  /** File name (no directory), e.g. "Button.story.jsx". */
  fileName: string;
  content: string;
}

// Renderable component extensions across all supported frameworks. Style/asset
// files are previewed indirectly (via the components that use them).
const RENDERABLE_EXTENSIONS = new Set([".tsx", ".jsx", ".vue", ".svelte"]);

/** True when this changed file is a component we can render on its own. */
export function isRenderableComponent(absPath: string): boolean {
  return RENDERABLE_EXTENSIONS.has(path.extname(absPath).toLowerCase());
}

/** A human/title label derived from the file name (e.g. "Button" from Button.tsx). */
export function componentTitle(absPath: string): string {
  return path.basename(absPath).replace(/\.(tsx?|jsx?|vue|svelte)$/i, "");
}

export type ExportShape = { kind: "default" } | { kind: "named"; name: string } | null;

/**
 * Heuristically determine how a JS/JSX component is exported, so the story
 * imports it correctly. Prefers a default export; otherwise the first
 * capitalized named export (the React/Solid convention). Returns null when
 * nothing looks like a component export — the caller then skips this file.
 */
export function detectExport(source: string): ExportShape {
  if (/\bexport\s+default\b/.test(source)) return { kind: "default" };

  const named =
    source.match(/\bexport\s+(?:async\s+)?function\s+([A-Z]\w*)/) ??
    source.match(/\bexport\s+const\s+([A-Z]\w*)\s*[:=]/) ??
    source.match(/\bexport\s*\{[^}]*\b([A-Z]\w*)\b/);
  if (named?.[1]) return { kind: "named", name: named[1] };

  return null;
}

function storyFileName(absPath: string, ext: string): string {
  return `${componentTitle(absPath)}.story.${ext}`;
}

// ── Per-framework story builders ───────────────────────────────────────────────

/** JSX story for React/Preact/Solid: import the component, render with no props. */
function buildJsxStory(entry: ComponentEntry): StoryFile | null {
  const shape = detectExport(entry.source);
  if (!shape) return null;

  const title = componentTitle(entry.absPath);
  const importSpec = JSON.stringify(entry.absPath);
  const importLine =
    shape.kind === "default"
      ? `import Component from ${importSpec};`
      : `import { ${shape.name} as Component } from ${importSpec};`;

  const content = `${importLine}

export const title = ${JSON.stringify(title)};

// Deterministic preview: renders the component with no props.
export default function Story() {
  return <Component />;
}
`;
  return { fileName: storyFileName(entry.absPath, "jsx"), content };
}

/** Vue story: a JS module that re-exports the SFC's default component. */
function buildVueStory(entry: ComponentEntry): StoryFile | null {
  const title = componentTitle(entry.absPath);
  const importSpec = JSON.stringify(entry.absPath);
  const content = `export { default } from ${importSpec};
export const title = ${JSON.stringify(title)};
`;
  return { fileName: storyFileName(entry.absPath, "js"), content };
}

/** Svelte story: a wrapper component that renders the changed component. */
function buildSvelteStory(entry: ComponentEntry): StoryFile | null {
  const importSpec = JSON.stringify(entry.absPath);
  const content = `<script>
  import Component from ${importSpec};
</script>

<Component />
`;
  return { fileName: storyFileName(entry.absPath, "svelte"), content };
}

/**
 * Build the deterministic story for a component in the given framework, or null
 * when it has no detectable component export (JS family only). Pure.
 */
export function buildStoryFor(
  framework: FrontendFramework,
  entry: ComponentEntry,
): StoryFile | null {
  const ext = path.extname(entry.absPath).toLowerCase();
  switch (framework) {
    case "vue":
      return ext === ".vue" ? buildVueStory(entry) : buildJsxStory(entry);
    case "svelte":
      return ext === ".svelte" ? buildSvelteStory(entry) : null;
    default:
      // react / preact / solid — JSX/TSX components.
      return buildJsxStory(entry);
  }
}

/**
 * Back-compat: the React deterministic story for a component, or null. Prefer
 * `buildStoryFor(framework, entry)`.
 */
export function buildFallbackStory(entry: ComponentEntry): StoryFile | null {
  return buildJsxStory(entry);
}
