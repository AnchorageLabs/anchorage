import type { ToolDefinition } from "./types.js";

/**
 * Filter the tool catalog by the run's granted capabilities. Tools without a
 * `capability` declaration are always available; gated tools are dropped when
 * the capability is absent. Drops also happen silently — the model is never
 * told a tool was removed, which prevents it from asking for capabilities it
 * lacks.
 */
export function filterToolsByCapability(
  tools: ToolDefinition[],
  capabilities: ReadonlySet<string>,
): ToolDefinition[] {
  return tools.filter((tool) => tool.capability === undefined || capabilities.has(tool.capability));
}

/**
 * Build an O(1) lookup map by tool name. Names must be unique within a run;
 * later definitions win when there are duplicates so callers can shadow a
 * built-in tool with a custom implementation by appending after `builtinTools`.
 */
export function buildToolIndex(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  const index = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    index.set(tool.name, tool);
  }
  return index;
}
