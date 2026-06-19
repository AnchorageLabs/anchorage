// Architecture governance (Fase 5 · F2). The graph-rule evaluator answers
// "did this diff introduce a forbidden import?" as a pure query over the import
// graph — zero tokens. A hard violation becomes a code.revision.request the
// existing feedback loop bounces to the coder. These pin the glob matcher, the
// tolerant constraints parser, and the forbid-import evaluation. Run with
// `node --test`.

import assert from "node:assert/strict";
import test from "node:test";
import { evaluateForbidImports, matchGlob, parseConstraints } from "../dist/policy.js";

test("matchGlob: ** spans depth, * stays within a segment", () => {
  assert.equal(matchGlob("src/db/**", "src/db/conn.ts"), true);
  assert.equal(matchGlob("src/db/**", "src/db/pg/pool.ts"), true);
  assert.equal(matchGlob("src/db/**", "src/dbx/conn.ts"), false);
  assert.equal(matchGlob("src/*.ts", "src/index.ts"), true);
  assert.equal(matchGlob("src/*.ts", "src/a/b.ts"), false);
  assert.equal(matchGlob("src/controllers/**", "src/controllers/user.ts"), true);
});

test("parseConstraints: reads the documented rule shape, defaults severity to hard", () => {
  const { rules, warnings } = parseConstraints(`
rules:
  - id: no-db-in-controllers
    type: forbid-import
    from: "src/controllers/**"
    to: "src/db/**"
    severity: hard
  - id: no-ui-in-domain
    type: forbid-import
    from: src/domain/**
    to: src/ui/**
`);
  assert.equal(warnings.length, 0);
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0], {
    id: "no-db-in-controllers",
    type: "forbid-import",
    from: "src/controllers/**",
    to: "src/db/**",
    severity: "hard",
  });
  // severity omitted → defaults to hard
  assert.equal(rules[1].severity, "hard");
});

test("parseConstraints: skips non-graph rule types and incomplete rules (with a warning)", () => {
  const { rules, warnings } = parseConstraints(`
rules:
  - id: future-rule
    type: require-test
    from: src/**
  - id: broken
    type: forbid-import
    from: src/a/**
`);
  assert.equal(rules.length, 0);
  assert.ok(warnings.some((w) => w.includes("incomplete")));
});

test("parseConstraints: garbage degrades to no rules, never throws", () => {
  const r = parseConstraints("}{ not yaml at all :::");
  assert.deepEqual(r.rules, []);
});

function graph(edges) {
  // edges: { importedFile: [importerFiles...] }
  const allFiles = [...new Set([...Object.keys(edges), ...Object.values(edges).flat()])];
  return { allFiles, importersOf: (t) => edges[t] ?? [] };
}

test("evaluateForbidImports: flags a changed importer that crosses a forbidden edge", () => {
  const rules = parseConstraints(`
rules:
  - id: no-db-in-controllers
    type: forbid-import
    from: src/controllers/**
    to: src/db/**
`).rules;
  const g = graph({
    "src/db/conn.ts": ["src/controllers/user.ts", "src/services/auth.ts"],
  });
  // Only the controller import is forbidden; and only when it's in the diff.
  const v = evaluateForbidImports(rules, ["src/controllers/user.ts"], g);
  assert.equal(v.length, 1);
  assert.equal(v[0].ruleId, "no-db-in-controllers");
  assert.equal(v[0].file, "src/controllers/user.ts");
  assert.equal(v[0].imports, "src/db/conn.ts");
  assert.equal(v[0].severity, "hard");
});

test("evaluateForbidImports: a forbidden import NOT in the diff is not flagged", () => {
  const rules = parseConstraints(`
rules:
  - id: no-db-in-controllers
    type: forbid-import
    from: src/controllers/**
    to: src/db/**
`).rules;
  const g = graph({ "src/db/conn.ts": ["src/controllers/user.ts"] });
  // The violating file exists but wasn't changed this run → no new violation.
  assert.deepEqual(evaluateForbidImports(rules, ["src/services/x.ts"], g), []);
});

test("evaluateForbidImports: a service importing db is allowed (from-glob doesn't match)", () => {
  const rules = parseConstraints(`
rules:
  - id: no-db-in-controllers
    type: forbid-import
    from: src/controllers/**
    to: src/db/**
`).rules;
  const g = graph({ "src/db/conn.ts": ["src/services/auth.ts"] });
  assert.deepEqual(evaluateForbidImports(rules, ["src/services/auth.ts"], g), []);
});

test("evaluateForbidImports: dedupes repeated (rule, file, import) edges", () => {
  const rules = parseConstraints(`
rules:
  - id: r
    type: forbid-import
    from: src/a/**
    to: src/b/**
`).rules;
  const g = graph({ "src/b/x.ts": ["src/a/one.ts", "src/a/one.ts"] });
  assert.equal(evaluateForbidImports(rules, ["src/a/one.ts"], g).length, 1);
});
