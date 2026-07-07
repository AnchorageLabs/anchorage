// Shared agent-prompt snippets, so every agent that can navigate a repo is
// instructed the SAME way. Keeping the wording in one place is the point: the
// "use the index, not grep" rule must be identical across the coder, planner,
// reviewer, issue-opener, triage, and any future repo-reading agent — drift
// between per-agent copies is how some agents ended up grepping a 1000-file repo
// while others used the graph.

/**
 * Batch independent tool calls into one turn. Every reply is one slow LLM
 * round-trip (observed ~4-7s in prod), and the tool loop + both provider
 * formats already execute EVERY tool call in a reply — yet production coder
 * runs burned 300+ turns issuing one small read_file per turn (35 minutes of
 * pure round-trips). Paste into any repo-reading agent's system prompt.
 */
export const BATCH_TOOL_CALLS_RULE = [
  "BATCH INDEPENDENT TOOL CALLS — every reply may include SEVERAL tool calls, and each reply costs a full round-trip, so never spend a whole turn on one small read:",
  "- When your next steps don't depend on each other's results — reading the files repo_map/locate_change/find_references just pointed you at, probing several directories, resolving several symbols — issue them TOGETHER in ONE reply (aim for 3-8 calls).",
  "- One call per turn is only right when its result determines what you do next (e.g. a shell_exec whose failure changes your plan, or an edit you must verify before the next edit).",
].join("\n");

/**
 * The hard rule: orient with the symbol/import graph before any grep/read_file
 * sweep. Every agent that holds `repoReadTools` (which carries repo_map /
 * locate_change / impact / find_references / tests_for / symbol_outline) should
 * paste this into its system prompt verbatim.
 */
export const GRAPH_FIRST_RULE = [
  "Orient with the INDEX, not with grep. This is a hard rule, not a preference:",
  "- Call repo_map ONCE at the very start for the core files. Do NOT open with a flurry of list_dir/grep/read_file probes.",
  "- For ANY named symbol (function, class, type, interface, constant, method) you MUST use locate_change (where to edit it), impact (its callers + transitive dependents) and/or find_references (exact sites) — these cross barrel re-exports and package boundaries a substring grep misses. Do them BEFORE reading files: they tell you which files to open.",
  "- Do NOT grep for a named symbol. grep is ONLY for free-form text/patterns (a string literal, a TODO, a regex). If you catch yourself about to grep an identifier, call locate_change/impact/find_references instead.",
  "- When the task names a CONCEPT rather than a symbol, you may grep once to discover the entry-point symbol, then switch to the index tools to expand from it — don't keep grepping.",
  "- Then read_file only the files the index pointed you at.",
].join("\n");
