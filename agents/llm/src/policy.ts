// Architecture governance (Fase 5 · F2) — the graph-rule class.
//
// Repo-specific architecture constraints live committed in .anchorage/
// constraints.yaml. The cheapest, most reliable class is the GRAPH RULE
// (forbid-import): "files matching <from> must not import files matching <to>".
// It is a pure query against the persisted import graph — zero LLM tokens — and
// it runs as a policy-check step between apply-code and run-tests. A hard
// violation emits a code.revision.request, which the existing feedback loop
// already bounces back to the coder, so architecture violations are fixed before
// a human ever sees the PR.
//
// Everything here is pure and storage-agnostic: the evaluator takes an injected
// view of the import graph, so it is unit-testable without a real index and a
// precise SQL/LSP backend can drop in later behind the same shape.

export type PolicySeverity = "hard" | "soft";

export interface PolicyRule {
  id: string;
  /** Only "forbid-import" today (the graph-rule class). Unknown types are skipped. */
  type: "forbid-import";
  /** Glob for the importing side ("src/controllers/**"). */
  from: string;
  /** Glob for the imported side ("src/db/**"). */
  to: string;
  /** hard blocks (revision request); soft is advisory. Default hard. */
  severity: PolicySeverity;
}

export interface PolicyViolation {
  ruleId: string;
  severity: PolicySeverity;
  /** The changed file that violates the rule (the importer). */
  file: string;
  /** The forbidden file it imports. */
  imports: string;
  message: string;
}

/** Minimal read view of the import graph the evaluator needs (injectable for tests). */
export interface ImportGraphView {
  /** Every indexed file path. */
  allFiles: string[];
  /** Files that directly import `targetFile`. */
  importersOf(targetFile: string): string[];
}

// ── glob matching ────────────────────────────────────────────────────────────
// Supports the two operators a path glob needs: `**` (any depth, incl. `/`) and
// `*` (a single segment, no `/`). Anchored to a full-path match.

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        // Swallow a trailing slash after ** so "a/**" matches "a/b" and "a/b/c".
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (/[.+?^${}()|[\]\\]/.test(c ?? "")) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}

// ── constraints.yaml parsing ──────────────────────────────────────────────────
// A tolerant parser for the documented shape (no YAML dependency in the agent
// runtime). Anything it can't read degrades to "no rules" + a warning — a broken
// constraints file must never crash a run or, worse, silently enforce nothing.
//
//   rules:
//     - id: no-db-in-controllers
//       type: forbid-import
//       from: "src/controllers/**"
//       to: "src/db/**"
//       severity: hard

export interface ParsedConstraints {
  rules: PolicyRule[];
  warnings: string[];
}

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

export function parseConstraints(text: string): ParsedConstraints {
  const warnings: string[] = [];
  const rules: PolicyRule[] = [];
  // Collect each list item's key/value pairs. A line starting (after indent)
  // with "- " opens a new item; "key: value" lines fill the current item.
  let current: Record<string, string> | null = null;
  const items: Record<string, string>[] = [];
  const commit = (): void => {
    if (current && Object.keys(current).length > 0) items.push(current);
    current = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, ""); // strip comments
    if (!line.trim()) continue;
    const listMatch = line.match(/^\s*-\s*(.*)$/);
    if (listMatch) {
      commit();
      current = {};
      const inline = listMatch[1]?.trim() ?? "";
      const kv = inline.match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
      if (kv?.[1]) current[kv[1]] = unquote(kv[2] ?? "");
      continue;
    }
    const kv = line.match(/^\s+([A-Za-z_]+)\s*:\s*(.+)$/);
    if (kv?.[1] && current) current[kv[1]] = unquote(kv[2] ?? "");
  }
  commit();

  for (const item of items) {
    if (item.type && item.type !== "forbid-import") continue; // other classes: skip
    if (!item.id || !item.from || !item.to) {
      warnings.push(`constraints: skipping incomplete rule ${JSON.stringify(item)}`);
      continue;
    }
    const severity: PolicySeverity = item.severity === "soft" ? "soft" : "hard";
    rules.push({ id: item.id, type: "forbid-import", from: item.from, to: item.to, severity });
  }
  return { rules, warnings };
}

// ── evaluation ────────────────────────────────────────────────────────────────

/**
 * Evaluate forbid-import rules against the changed files. For each rule, the
 * forbidden targets are the indexed files matching `to`; a violation is any of
 * their importers that is BOTH a changed file and matches `from`. Pure: the
 * import graph is injected. Deduped on (ruleId, file, imports).
 */
export function evaluateForbidImports(
  rules: PolicyRule[],
  changedFiles: string[],
  graph: ImportGraphView,
): PolicyViolation[] {
  const changed = new Set(changedFiles);
  const seen = new Set<string>();
  const violations: PolicyViolation[] = [];

  for (const rule of rules) {
    if (rule.type !== "forbid-import") continue;
    const targets = graph.allFiles.filter((f) => matchGlob(rule.to, f));
    for (const target of targets) {
      for (const importer of graph.importersOf(target)) {
        if (!changed.has(importer) || !matchGlob(rule.from, importer)) continue;
        const key = `${rule.id}|${importer}|${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push({
          ruleId: rule.id,
          severity: rule.severity,
          file: importer,
          imports: target,
          message: `${importer} imports ${target}, forbidden by rule "${rule.id}" (${rule.from} → ${rule.to})`,
        });
      }
    }
  }
  return violations;
}
