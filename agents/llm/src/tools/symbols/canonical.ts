// Canonical-engine adapter (ADR-0032). The agent's in-loop tools (repo_map,
// find_references, impact, locate_change, relevant_tests, symbol_outline) read
// through `getIndexStore`. This module lets that seam resolve to the ONE
// canonical engine — cartographer's `@anchorage/cartographer-index`, the same
// engine the orchestrator already uses and the one with resolved Go/TS import
// edges — instead of this package's weaker JSON store, without a compile-time
// cross-repo dependency.
//
// Mechanism mirrors how the orchestrator consumes cartographer: a RUNTIME
// dynamic import via a non-literal specifier (so tsc never tries to resolve the
// cross-repo package), resolved from the baked `/cartographer-index` in the
// worker image. When it can't be resolved (local dev without the bake) or the
// index is empty, this returns null and the caller falls back to the JSON store
// — an explicit, observable fallback, never a silent swallow.

import type { SymbolDef } from "./engine.js";
import type { DefSite, ImpactResult, SymbolIndex } from "./store.js";

// Minimal shape of what we use from `@anchorage/cartographer-index`. Typed
// locally because the package is resolved at runtime, not compile time.
interface CartoSymbolRow {
  file: string;
  name: string;
  kind: string;
  line: number;
}
interface CartoStore {
  definitionsOf(name: string): CartoSymbolRow[];
  filesReferencing(name: string): string[];
  inDegreeRanking(): { file: string; lang: string; inDegree: number }[];
  symbolsInFile(file: string): CartoSymbolRow[];
  stats(): { files: number };
}
interface CartoModule {
  getOrBuildIndex(root: string, opts?: { refresh?: boolean }): Promise<CartoStore | null>;
  outline(store: CartoStore, file: string): CartoSymbolRow[];
  impact(
    store: CartoStore,
    symbols: string[],
  ): {
    definitions: CartoSymbolRow[];
    references: { file: string; isTest: boolean }[];
    dependents: string[];
    tests: string[];
  };
  testsFor(store: CartoStore, file: string): string[];
}

// Resolved once per process: the module (or null when unavailable). A non-literal
// specifier keeps tsc from resolving the cross-repo package at build time.
let modulePromise: Promise<CartoModule | null> | undefined;
function loadCartographer(): Promise<CartoModule | null> {
  if (!modulePromise) {
    const specifier = "@anchorage/cartographer-index";
    modulePromise = import(specifier)
      .then((m) => m as unknown as CartoModule)
      .catch(() => null);
  }
  return modulePromise;
}

const toDef = (r: CartoSymbolRow): DefSite => ({
  file: r.file,
  name: r.name,
  kind: r.kind,
  line: r.line,
});

/** A SymbolIndex backed by the canonical cartographer engine. */
class CartographerIndex implements SymbolIndex {
  constructor(
    private readonly mod: CartoModule,
    private readonly store: CartoStore,
  ) {}

  get fileCount(): number {
    return this.store.stats().files;
  }

  definitionsOf(name: string): DefSite[] {
    return this.store.definitionsOf(name).map(toDef);
  }

  filesReferencing(name: string): string[] {
    return this.store.filesReferencing(name);
  }

  inDegreeRanking(): { file: string; lang: string; inDegree: number }[] {
    return this.store.inDegreeRanking();
  }

  outline(file: string): SymbolDef[] | null {
    const rows = this.mod.outline(this.store, file);
    if (rows.length === 0) return null;
    return rows.map((r) => ({ name: r.name, kind: r.kind, line: r.line }));
  }

  impact(symbol: string): ImpactResult {
    const r = this.mod.impact(this.store, [symbol]);
    return {
      definitions: r.definitions.map(toDef),
      references: r.references.map((ref) => ({ file: ref.file, isTest: ref.isTest })),
      dependents: r.dependents,
      tests: r.tests,
    };
  }

  testsFor(file: string): string[] {
    return this.mod.testsFor(this.store, file);
  }
}

/**
 * Open the canonical (cartographer) index for a workspace, or null when the
 * package isn't resolvable (no bake — local dev) or the index is empty. Null is
 * the signal for the caller to fall back to the JSON store.
 */
export async function openCanonicalIndex(root: string): Promise<SymbolIndex | null> {
  const mod = await loadCartographer();
  if (!mod) return null;
  try {
    const store = await mod.getOrBuildIndex(root);
    if (!store) return null;
    return new CartographerIndex(mod, store);
  } catch (err) {
    // Observable, not swallowed: stderr keeps the stdout NDJSON protocol clean.
    console.error(
      `[symbol-index] canonical engine unavailable, falling back to JSON store: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
