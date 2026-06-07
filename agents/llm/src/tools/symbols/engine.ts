// Tree-sitter symbol engine — the backend behind the `find_references` and
// `symbol_outline` tools. It parses workspace files with tree-sitter (via the
// pure-WASM `web-tree-sitter`, grammars from `tree-sitter-wasms`) and walks the
// syntax tree generically: any node whose type names a definition + has a
// `name` field is a definition; any identifier-typed node is a candidate
// reference. This is *syntactic* fidelity (accurate definitions, identifier-
// matched references) — not type resolution; it does not resolve overloads,
// imports, or shadowing. Everything fails closed: an unsupported language,
// missing grammar, oversized file, or parse error yields `null` so the caller
// falls back to grep. Provider seam: a per-language LSP can replace this engine
// behind the same tool surface later without touching the tools or the agents.

import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Language, type Node, Parser } from "web-tree-sitter";

const require = createRequire(import.meta.url);

// Files larger than this are skipped (return null → fall back to grep). Keeps
// a single tool call bounded regardless of repo size.
const MAX_PARSE_BYTES = 512_000;
// Cap on AST nodes visited per file, guarding against pathological inputs.
const MAX_NODES_PER_FILE = 400_000;

// Source extension → tree-sitter-wasms grammar basename. Only languages with a
// meaningful symbol structure are mapped; anything else fails closed.
const EXT_TO_GRAMMAR: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".cs": "c_sharp",
  ".rb": "ruby",
  ".php": "php",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".lua": "lua",
  ".scala": "scala",
  ".swift": "swift",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".sol": "solidity",
  ".zig": "zig",
  ".vue": "vue",
};

// Node types that denote a definition. Substring match keeps it grammar-
// agnostic (function_declaration, function_definition, function_item,
// method_definition, class_declaration, class_specifier, struct_item,
// interface_declaration, type_spec, …). A definition is only recorded when a
// name can be extracted, which naturally de-dupes wrapper/inner pairs.
const DEFINITION_TYPE =
  /(function|method|class|interface|struct|enum|trait|impl|module|namespace|constructor|type_alias|type_spec|type_item|type_declaration|field|property|constant)/;

let initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
}

// Loaded grammars are cached for the process; a load failure caches `null` so
// we don't retry a missing/incompatible grammar on every call.
const grammarCache = new Map<string, Language | null>();
async function loadGrammar(name: string): Promise<Language | null> {
  const cached = grammarCache.get(name);
  if (cached !== undefined) return cached;
  let lang: Language | null = null;
  try {
    const grammarDir = `${path.dirname(require.resolve("tree-sitter-wasms/package.json"))}/out`;
    lang = await Language.load(path.join(grammarDir, `tree-sitter-${name}.wasm`));
  } catch {
    lang = null;
  }
  grammarCache.set(name, lang);
  return lang;
}

/** Grammar name for a path, or null when the language is unsupported. */
export function grammarForPath(filePath: string): string | null {
  return EXT_TO_GRAMMAR[path.extname(filePath).toLowerCase()] ?? null;
}

interface ParsedFile {
  root: Node;
  text: string;
}

async function parseFile(absPath: string): Promise<ParsedFile | null> {
  const grammar = grammarForPath(absPath);
  if (!grammar) return null;
  const stats = await stat(absPath).catch(() => null);
  if (!stats?.isFile() || stats.size > MAX_PARSE_BYTES) return null;
  const code = await readFile(absPath, "utf8").catch(() => null);
  if (code === null) return null;

  await ensureInit();
  const lang = await loadGrammar(grammar);
  if (!lang) return null;
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(code);
  const root = tree?.rootNode;
  if (!root) return null;
  return { root, text: code };
}

// Iterative pre-order walk (explicit stack — deep trees must not overflow).
function walk(root: Node, visit: (node: Node) => void): void {
  const stack: Node[] = [root];
  let visited = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    visit(node);
    if (++visited >= MAX_NODES_PER_FILE) return;
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
}

function isIdentifier(type: string): boolean {
  return type === "identifier" || type.endsWith("_identifier");
}

function shortKind(nodeType: string): string {
  // "function_declaration" → "function"; "type_spec" → "type".
  return nodeType.split("_")[0] ?? nodeType;
}

function definitionNameNode(node: Node): Node | null {
  const named = node.childForFieldName("name");
  if (named) return named;
  // Fallback: first identifier-typed named child.
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && isIdentifier(child.type)) return child;
  }
  return null;
}

export interface SymbolDef {
  name: string;
  kind: string;
  line: number;
}

const MAX_OUTLINE_SYMBOLS = 300;

/** Top-level-ish definitions in a file, or null when the file can't be parsed. */
export async function outlineFile(absPath: string): Promise<SymbolDef[] | null> {
  const parsed = await parseFile(absPath);
  if (!parsed) return null;
  const defs: SymbolDef[] = [];
  walk(parsed.root, (node) => {
    if (defs.length >= MAX_OUTLINE_SYMBOLS) return;
    if (!DEFINITION_TYPE.test(node.type)) return;
    const nameNode = definitionNameNode(node);
    if (!nameNode) return;
    defs.push({
      name: nameNode.text,
      kind: shortKind(node.type),
      line: nameNode.startPosition.row + 1,
    });
  });
  return defs;
}

export interface SymbolRef {
  file: string;
  line: number;
  isDefinition: boolean;
}

/**
 * Occurrences of `symbol` in a single file, each flagged as a definition (the
 * identifier is the `name` of a definition node) or a plain reference. Returns
 * null when the file can't be parsed (caller falls back to grep).
 */
export async function findReferencesInFile(
  absPath: string,
  relPath: string,
  symbol: string,
): Promise<SymbolRef[] | null> {
  const parsed = await parseFile(absPath);
  if (!parsed) return null;
  const refs: SymbolRef[] = [];
  walk(parsed.root, (node) => {
    if (!isIdentifier(node.type) || node.text !== symbol) return;
    const parent = node.parent;
    const isDefinition =
      parent !== null &&
      DEFINITION_TYPE.test(parent.type) &&
      parent.childForFieldName("name")?.startIndex === node.startIndex;
    refs.push({ file: relPath, line: node.startPosition.row + 1, isDefinition });
  });
  return refs;
}
