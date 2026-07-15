/**
 * MDX parsing for the lint engine.
 *
 * Uses Sätteri's own `mdxToMdast` — the *same parser that renders the
 * site* — so the linter never disagrees with what actually ships. No
 * shadow AST, no reintroduced unified pipeline, and the Rust parser keeps
 * the pass fast. Sätteri exposes `mdxToMdast` and unist positions
 * precisely for this kind of read-only inspection; the remark-plugin
 * no-op only affects render-time transforms wired into
 * `markdown.processor`, not direct parse calls like this one.
 */

import { mdxToMdast } from "satteri";
import { parse as parseYaml } from "yaml";

export interface Point {
  line: number;
  column: number;
  offset?: number;
}

export interface NodePosition {
  start: Point;
  end: Point;
}

/**
 * A minimal mdast node view. Deliberately structural and dependency-light
 * (no `@types/mdast` coupling) — rules read the handful of fields they
 * need and tolerate the rest.
 */
export interface MdNode {
  type: string;
  children?: MdNode[];
  position?: NodePosition;
  value?: string;
  depth?: number;
  lang?: string | null;
  name?: string | null;
  url?: string;
  [key: string]: unknown;
}

export interface MdRoot extends MdNode {
  type: "root";
  children: MdNode[];
}

export interface ParsedFile {
  /** Path relative to the project root, for display. */
  path: string;
  /** Absolute path on disk. */
  absPath: string;
  /** Full source text. */
  source: string;
  /** Source split into lines once, reused by rules + the formatter. */
  lines: string[];
  /** mdast root from Sätteri. */
  tree: MdRoot;
  /** Raw frontmatter body (between the `---` fences), or null when absent. */
  frontmatterRaw: string | null;
  /** 1-based source line the frontmatter body starts on (the line after
   * the opening `---`). */
  frontmatterStartLine: number;
  /** Parsed frontmatter object. `null` when absent or unparseable YAML. */
  frontmatter: Record<string, unknown> | null;
  /** Collection name inferred from the path (`docs`, `partials`, …), or null. */
  collection: string | null;
  /** Set when the MDX body failed to parse (won't render). Rules are
   * skipped; the engine emits a single `nimbus/mdx-syntax` diagnostic. */
  parseError: { message: string; line: number; column: number } | null;
}

/** Depth-first walk of an mdast tree, visitor called on every node. */
export function visit(node: MdNode, visitor: (node: MdNode) => void): void {
  visitor(node);
  if (node.children) {
    for (const child of node.children) visit(child, visitor);
  }
}

/** Collect every node of a given `type`. */
export function collect(root: MdNode, type: string): MdNode[] {
  const out: MdNode[] = [];
  visit(root, (n) => {
    if (n.type === type) out.push(n);
  });
  return out;
}

/** 1-based start position of a node, falling back to (1,1). */
export function startOf(node: MdNode): { line: number; column: number } {
  return {
    line: node.position?.start.line ?? 1,
    column: node.position?.start.column ?? 1,
  };
}

/** Concatenated text of a node's `text` descendants. */
export function textOf(node: MdNode): string {
  let out = "";
  visit(node, (n) => {
    if (n.type === "text" && typeof n.value === "string") out += n.value;
  });
  return out;
}

/**
 * Find the first node of a given `type` whose start position matches the
 * given 1-based (line, column). Used by remark-lint wrappers to recover
 * the AST node from the rule's reported position so we can compute
 * surgical fixes or dynamic messages.
 *
 * Returns `null` when no matching node exists at that position — a defensive
 * fallback for any future tree-shape drift between remark-parse and Sätteri.
 */
export function findNodeAt(
  root: MdNode,
  type: string,
  line: number,
  column: number,
): MdNode | null {
  let found: MdNode | null = null;
  visit(root, (n) => {
    if (found) return;
    if (n.type !== type) return;
    const start = n.position?.start;
    if (!start) return;
    if (start.line === line && start.column === column) found = n;
  });
  return found;
}

/**
 * Parse a source string into a `ParsedFile`. `path`/`absPath`/`collection`
 * are caller-supplied; pass-throughs for display and per-collection logic.
 */
export function parseSource(
  source: string,
  meta: { path: string; absPath: string; collection: string | null },
): ParsedFile {
  let tree: MdRoot;
  let parseError: ParsedFile["parseError"] = null;
  try {
    tree = mdxToMdast(source) as unknown as MdRoot;
  } catch (err) {
    // A file that won't parse won't render either — surface it instead of
    // crashing the whole lint run.
    tree = { type: "root", children: [] };
    parseError = describeParseError(err, source);
  }

  const yamlNode = tree.children.find((n) => n.type === "yaml");
  const frontmatterRaw =
    yamlNode && typeof yamlNode.value === "string" ? yamlNode.value : null;
  // The yaml node sits on the opening `---`; its body starts the next line.
  const frontmatterStartLine = (yamlNode?.position?.start.line ?? 0) + 1;

  let frontmatter: Record<string, unknown> | null = null;
  if (frontmatterRaw !== null) {
    try {
      const parsed = parseYaml(frontmatterRaw);
      frontmatter =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      frontmatter = null;
    }
  }

  return {
    path: meta.path,
    absPath: meta.absPath,
    source,
    lines: source.split("\n"),
    tree,
    frontmatterRaw,
    frontmatterStartLine,
    frontmatter,
    collection: meta.collection,
    parseError,
  };
}

/**
 * Turn a Sätteri parse throw into a positioned message. The error text
 * carries a byte offset (`at byte N`); map it to line/column so the
 * diagnostic points at the right spot.
 */
function describeParseError(
  err: unknown,
  source: string,
): { message: string; line: number; column: number } {
  const message = err instanceof Error ? err.message : String(err);
  const byteMatch = message.match(/at byte (\d+)/);
  let line = 1;
  let column = 1;
  if (byteMatch) {
    const byteOffset = Number(byteMatch[1]);
    const prefix = Buffer.from(source, "utf8")
      .subarray(0, byteOffset)
      .toString("utf8");
    const prefixLines = prefix.split("\n");
    line = prefixLines.length;
    column = (prefixLines[prefixLines.length - 1]?.length ?? 0) + 1;
  }
  return { message, line, column };
}
