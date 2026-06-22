// Generates the per-component "stories" the gallery renders. A story is a tiny
// module whose default export renders one changed component in isolation.
//
// This increment ships the DETERMINISTIC story: import the component and render
// it with no props, inside the gallery's error boundary. That already previews
// presentational / prop-optional components faithfully and, crucially, proves
// the isolation pipeline (Vite resolving against an arbitrary repo) without the
// app's auth/data machinery. The next increment swaps in LLM-synthesized stories
// with realistic mock props + provider/data stubs for components that need them.

import path from "node:path";

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

// File extensions we'll attempt to render as components. Style/asset files are
// previewed indirectly (via the components that use them), not as their own card.
const RENDERABLE_EXTENSIONS = new Set([".tsx", ".jsx"]);

/** True when this changed file is a component we can render on its own. */
export function isRenderableComponent(absPath: string): boolean {
  return RENDERABLE_EXTENSIONS.has(path.extname(absPath).toLowerCase());
}

/** A human/title label derived from the file name (e.g. "Button" from Button.tsx). */
export function componentTitle(absPath: string): string {
  return path.basename(absPath).replace(/\.[jt]sx?$/i, "");
}

/** A unique-ish story filename for a component path. */
export function storyFileName(absPath: string): string {
  return `${componentTitle(absPath)}.story.jsx`;
}

export type ExportShape = { kind: "default" } | { kind: "named"; name: string } | null;

/**
 * Heuristically determine how the component is exported, so the story imports it
 * correctly. Prefers a default export; otherwise the first capitalized named
 * export (the React component convention). Returns null when nothing looks like
 * a component export — the caller then skips this file.
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

/**
 * Build the deterministic story for a component, or null when it has no
 * detectable component export. Pure — returns the file to write.
 */
export function buildFallbackStory(entry: ComponentEntry): StoryFile | null {
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

// Deterministic preview: renders the component with no props. Components that
// require props or context show their error in the gallery card until the
// LLM-synthesized story (next increment) supplies realistic mocks.
export default function Story() {
  return <Component />;
}
`;

  return { fileName: storyFileName(entry.absPath), content };
}
