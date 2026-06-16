// Persisted symbol/import index — the native backbone behind impact, tests_for,
// repo_map, find_references and symbol_outline. It maintains a whole-repo view
// (definitions, an identifier→files inverted index, and the import graph) at
// .anchorage/index/index.json, delta-refreshed by per-file content hash so a
// warm call is a hash check rather than a re-scan.
//
// JSON, not SQLite: this runs inside the agent's own runtime, where a native
// module (better-sqlite3 + its prebuilt/flags) is a portability liability. The
// query surface below is deliberately storage-agnostic, so a SQLite or LSP
// backend can drop in later behind the same methods (the "provider seam") with
// no change to the tools. It supersedes the external `cartographer` binary the
// impact/tests_for tools shell out to today.
//
// Everything fails soft: a corrupt or version-mismatched index is rebuilt; an
// unparseable file is skipped (it stays grep-reachable); a git failure yields a
// null build so callers fall back to their per-call path.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, mkdir, rename, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { analyzeFile, grammarForPath, type SymbolDef } from "./engine.js";

const INDEX_DIR = ".anchorage/index";
const INDEX_FILE = "index.json";
// Bump when the persisted shape changes; a mismatch triggers a full rebuild.
const INDEX_VERSION = 1;

const MAX_FILES = 8000; // monorepo guard — bounds a cold build
const MAX_BYTES_PER_FILE = 512_000; // mirrors the engine's parse cap
const GIT_TIMEOUT_MS = 15_000;

// ── Persisted shape ───────────────────────────────────────────────────────────
// Only per-file facts are stored. The inverted/reverse indices that queries need
// are derived in memory at load time — cheap to recompute and impossible to let
// drift out of sync with the per-file entries on an incremental update.

interface FileEntry {
  hash: string; // sha1 of file bytes; the incremental-refresh key
  lang: string; // tree-sitter grammar name
  defs: SymbolDef[]; // definitions in this file (name, kind, line)
  names: string[]; // distinct identifiers referenced (for the inverted index)
  imports: string[]; // module tokens this file imports (for the import graph)
}

interface PersistedIndex {
  version: number;
  builtAt: string;
  files: Record<string, FileEntry>;
}

// ── git + hashing ───────────────────────────────────────────────────────────

function gitListFiles(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const out: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      resolve(
        Buffer.concat(out)
          .toString("utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0),
      );
    });
  });
}

function hashContent(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex");
}

// ── import extraction (regex; matches repo_map's token model) ─────────────────
// Linear, backtracking-safe. The forward graph is file → imported module tokens;
// an edge to file B exists when an import's last segment equals fileToken(B).

const JS_FROM = /\bfrom\s*['"]([^'"]+)['"]/g;
const JS_CALL = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const JS_BARE = /^\s*import\s*['"]([^'"]+)['"]/gm;
const PY_FROM = /^\s*from\s+([\w.]+)\s+import\b/gm;
const PY_IMPORT = /^\s*import\s+([\w.]+)/gm;

/** The imported module's final segment: "./tools/budget.js" → "budget". */
export function moduleToken(spec: string): string {
  let s = spec.trim();
  if (s.includes("/")) s = s.slice(s.lastIndexOf("/") + 1);
  else if (s.includes(".")) s = s.slice(s.lastIndexOf(".") + 1);
  return s.replace(/\.(m|c)?[jt]sx?$/i, "");
}

/** A file's basename without source extension: "tools/budget.ts" → "budget". */
export function fileToken(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  return base.replace(/\.(m|c)?[jt]sx?$|\.(py|go|rs|rb|java|kt|php|cs)$/i, "");
}

function importTokens(relPath: string, code: string): string[] {
  const ext = path.extname(relPath).toLowerCase();
  const specs = new Set<string>();
  const collect = (re: RegExp) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(code);
    while (m !== null) {
      if (m[1]) {
        const tok = moduleToken(m[1]);
        if (tok.length > 0) specs.add(tok);
      }
      m = re.exec(code);
    }
  };
  if (ext === ".py") {
    collect(PY_FROM);
    collect(PY_IMPORT);
  } else {
    collect(JS_FROM);
    collect(JS_CALL);
    collect(JS_BARE);
  }
  return [...specs];
}

// ── test-file heuristic ───────────────────────────────────────────────────────

const TEST_PATH = /(^|\/)(__tests__|tests?|spec)\/|(\.|_)(test|spec)\.[a-z]+$|_test\.[a-z]+$/i;

export function isTestPath(relPath: string): boolean {
  return TEST_PATH.test(relPath);
}

// ── the store ─────────────────────────────────────────────────────────────────

export interface DefSite {
  file: string;
  name: string;
  kind: string;
  line: number;
}

export interface ImpactResult {
  definitions: DefSite[];
  /** Files that reference the symbol (identifier present), each flagged isTest. */
  references: { file: string; isTest: boolean }[];
  /** Files that import a defining file, transitively (reverse-import closure). */
  dependents: string[];
  /** Test files among references/dependents plus name-mirrored tests. */
  tests: string[];
}

export class IndexStore {
  readonly root: string;
  private files: Map<string, FileEntry>;

  // Derived indices, rebuilt whenever the file set changes.
  private nameToFiles = new Map<string, Set<string>>(); // identifier → files referencing it
  private defNameToFiles = new Map<string, Set<string>>(); // identifier → files defining it
  private importers = new Map<string, Set<string>>(); // module token → files importing it
  private fileByToken = new Map<string, Set<string>>(); // fileToken → files with that basename

  private constructor(root: string, persisted: PersistedIndex) {
    this.root = root;
    this.files = new Map(Object.entries(persisted.files));
    this.rebuildDerived();
  }

  private indexPath(): string {
    return path.join(this.root, INDEX_DIR, INDEX_FILE);
  }

  /** Recompute the in-memory inverted/reverse indices from the per-file entries. */
  private rebuildDerived(): void {
    this.nameToFiles.clear();
    this.defNameToFiles.clear();
    this.importers.clear();
    this.fileByToken.clear();
    const add = (m: Map<string, Set<string>>, key: string, file: string) => {
      let set = m.get(key);
      if (!set) {
        set = new Set();
        m.set(key, set);
      }
      set.add(file);
    };
    for (const [rel, entry] of this.files) {
      add(this.fileByToken, fileToken(rel), rel);
      for (const name of entry.names) add(this.nameToFiles, name, rel);
      for (const def of entry.defs) add(this.defNameToFiles, def.name, rel);
      for (const tok of entry.imports) add(this.importers, tok, rel);
    }
  }

  /** Open the persisted index (rebuilding if missing/corrupt/stale), then refresh. */
  static async open(root: string): Promise<IndexStore | null> {
    let persisted: PersistedIndex = { version: INDEX_VERSION, builtAt: "", files: {} };
    const file = path.join(root, INDEX_DIR, INDEX_FILE);
    const raw = await readFile(file, "utf8").catch(() => null);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as PersistedIndex;
        if (parsed.version === INDEX_VERSION && parsed.files) persisted = parsed;
      } catch {
        // corrupt — fall through to a clean rebuild
      }
    }
    const store = new IndexStore(root, persisted);
    const ok = await store.refresh();
    return ok ? store : null;
  }

  /**
   * Bring the index in line with the working tree: hash every tracked source
   * file, re-analyze only those whose content changed, drop deleted ones. Returns
   * false when the file listing can't be obtained (caller falls back). Persists
   * only when something actually changed.
   */
  async refresh(): Promise<boolean> {
    const listed = await gitListFiles(this.root);
    if (listed === null) return false;
    const sources = listed.filter((f) => grammarForPath(f) !== null).slice(0, MAX_FILES);

    const next = new Map<string, FileEntry>();
    let changed = false;
    const present = new Set<string>();

    for (const rel of sources) {
      present.add(rel);
      const abs = path.join(this.root, rel);
      const st = await stat(abs).catch(() => null);
      if (!st?.isFile() || st.size > MAX_BYTES_PER_FILE) continue;
      const buf = await readFile(abs).catch(() => null);
      if (buf === null) continue;
      const hash = hashContent(buf);
      const existing = this.files.get(rel);
      if (existing && existing.hash === hash) {
        next.set(rel, existing);
        continue;
      }
      const entry = await this.analyze(abs, rel, buf.toString("utf8"), hash);
      if (entry) {
        next.set(rel, entry);
        changed = true;
      }
    }
    // Anything in the old set but no longer tracked was deleted.
    for (const rel of this.files.keys()) {
      if (!present.has(rel)) changed = true;
    }

    if (changed || this.files.size !== next.size) {
      this.files = next;
      this.rebuildDerived();
      await this.persist();
    }
    return true;
  }

  /** Re-analyze a single path after a mid-run edit (B4). No-op if unchanged. */
  async refreshFile(relPath: string): Promise<void> {
    const rel = relPath.replaceAll("\\", "/");
    if (grammarForPath(rel) === null) return;
    const abs = path.join(this.root, rel);
    const st = await stat(abs).catch(() => null);
    if (!st?.isFile()) {
      // Deleted/moved: drop it.
      if (this.files.delete(rel)) {
        this.rebuildDerived();
        await this.persist();
      }
      return;
    }
    if (st.size > MAX_BYTES_PER_FILE) return;
    const buf = await readFile(abs).catch(() => null);
    if (buf === null) return;
    const hash = hashContent(buf);
    if (this.files.get(rel)?.hash === hash) return;
    const entry = await this.analyze(abs, rel, buf.toString("utf8"), hash);
    if (!entry) return;
    this.files.set(rel, entry);
    this.rebuildDerived();
    await this.persist();
  }

  private async analyze(
    abs: string,
    rel: string,
    code: string,
    hash: string,
  ): Promise<FileEntry | null> {
    const analysis = await analyzeFile(abs);
    if (!analysis) return null;
    return {
      hash,
      lang: grammarForPath(rel) ?? "?",
      defs: analysis.defs,
      names: analysis.names,
      imports: importTokens(rel, code),
    };
  }

  private async persist(): Promise<void> {
    const dir = path.join(this.root, INDEX_DIR);
    await mkdir(dir, { recursive: true }).catch(() => {});
    const payload: PersistedIndex = {
      version: INDEX_VERSION,
      // Caller-independent: avoids a Date dependency in tests; stamped by writer.
      builtAt: new Date().toISOString(),
      files: Object.fromEntries(this.files),
    };
    // Atomic write: temp + rename, so a concurrent reader never sees a partial file.
    const tmp = path.join(dir, `.${INDEX_FILE}.tmp`);
    await writeFile(tmp, JSON.stringify(payload), "utf8").catch(() => {});
    await rename(tmp, this.indexPath()).catch(() => {});
  }

  // ── queries ─────────────────────────────────────────────────────────────────

  get fileCount(): number {
    return this.files.size;
  }

  /** Every definition of `name` across the repo. */
  definitionsOf(name: string): DefSite[] {
    const sites: DefSite[] = [];
    for (const rel of this.defNameToFiles.get(name) ?? []) {
      const entry = this.files.get(rel);
      if (!entry) continue;
      for (const def of entry.defs) {
        if (def.name === name) sites.push({ file: rel, name, kind: def.kind, line: def.line });
      }
    }
    return sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  /** Files that reference `name` anywhere (identifier-matched). */
  filesReferencing(name: string): string[] {
    return [...(this.nameToFiles.get(name) ?? [])].sort();
  }

  /** Files that directly import `targetFile` (via its basename token). */
  directImportersOf(targetFile: string): string[] {
    return [...(this.importers.get(fileToken(targetFile)) ?? [])].sort();
  }

  /** Transitive reverse-import closure: everything that depends on `targetFile`. */
  dependentsOf(targetFile: string): string[] {
    const seen = new Set<string>();
    const queue = [targetFile];
    while (queue.length > 0) {
      const cur = queue.pop();
      if (cur === undefined) continue;
      for (const importer of this.importers.get(fileToken(cur)) ?? []) {
        if (importer === targetFile || seen.has(importer)) continue;
        seen.add(importer);
        queue.push(importer);
      }
    }
    return [...seen].sort();
  }

  /** repo_map's signal: file → how many distinct files import it (in-degree). */
  inDegreeRanking(): { file: string; lang: string; inDegree: number }[] {
    return [...this.files.entries()]
      .map(([rel, entry]) => ({
        file: rel,
        lang: entry.lang,
        inDegree: this.importers.get(fileToken(rel))?.size ?? 0,
      }))
      .sort((a, b) => b.inDegree - a.inDegree || a.file.localeCompare(b.file));
  }

  /** Definitions in one file (symbol_outline from the index). */
  outline(relPath: string): SymbolDef[] | null {
    const entry = this.files.get(relPath.replaceAll("\\", "/"));
    return entry ? entry.defs : null;
  }

  /** Test files covering `sourceFile`: dependents that are tests + name-mirrored. */
  testsFor(sourceFile: string): string[] {
    const rel = sourceFile.replaceAll("\\", "/");
    const tests = new Set<string>();
    for (const dep of this.dependentsOf(rel)) if (isTestPath(dep)) tests.add(dep);
    // Name-mirrored tests (foo.ts → foo.test.ts), even if they don't import it.
    const token = fileToken(rel);
    for (const candidate of this.fileByToken.keys()) {
      if (candidate === token) {
        for (const f of this.fileByToken.get(candidate) ?? []) {
          if (f !== rel && isTestPath(f)) tests.add(f);
        }
      }
    }
    return [...tests].sort();
  }

  /** The full blast radius of a symbol — the native equivalent of `impact`. */
  impact(symbol: string): ImpactResult {
    const definitions = this.definitionsOf(symbol);
    const references = this.filesReferencing(symbol).map((file) => ({
      file,
      isTest: isTestPath(file),
    }));
    const dependents = new Set<string>();
    for (const def of definitions) for (const d of this.dependentsOf(def.file)) dependents.add(d);
    const tests = new Set<string>();
    for (const ref of references) if (ref.isTest) tests.add(ref.file);
    for (const d of dependents) if (isTestPath(d)) tests.add(d);
    for (const def of definitions) for (const t of this.testsFor(def.file)) tests.add(t);
    return {
      definitions,
      references,
      dependents: [...dependents].sort(),
      tests: [...tests].sort(),
    };
  }
}

// Per-root store cache: one in-memory index per workspace for the process
// lifetime, so repeated tool calls in a run reuse it (and the mid-run reindex in
// B4 mutates the same instance the read tools query).
const stores = new Map<string, Promise<IndexStore | null>>();

/** Get (or build) the index for a workspace root. Cached per process. */
export function getIndexStore(root: string): Promise<IndexStore | null> {
  const key = path.resolve(root);
  let existing = stores.get(key);
  if (!existing) {
    existing = IndexStore.open(key);
    stores.set(key, existing);
  }
  return existing;
}

/**
 * The already-built store for a root, or null if none has been opened yet.
 * Used by the mid-run reindex (B4): a write keeps an EXISTING index in sync but
 * never triggers a cold full build — if nothing has queried the index yet, the
 * next read tool builds it fresh from the working tree anyway.
 */
export function peekIndexStore(root: string): Promise<IndexStore | null> | null {
  return stores.get(path.resolve(root)) ?? null;
}

/** Drop the cached store for a root (tests / explicit invalidation). */
export function clearIndexStore(root: string): void {
  stores.delete(path.resolve(root));
}
