/**
 * Detectors for the Markdown style rules, run on the Sätteri tree the lint
 * engine already parsed. Each reports the nodes and positions the
 * remark-lint rule it replaced did (`remark-lint-*` 4.x), in the same order:
 * the rules wrap these with their own messages and fixes, and
 * `test/lint/native-parity.test.ts` holds them to the old output.
 *
 * A report is placed at the node's position (start and end), except the list
 * marker, which reports only the marker's start point.
 */

import type { MdNode, MdRoot } from "./parse.js";
import type { RuleReport } from "./rule.js";

type Point = { line?: number; column?: number; offset?: number };

/** Walks `tree` depth-first, parents before children; return `"skip"` to stay out of a node's children. */
function visitParents(tree: MdNode, visitor: (node: MdNode, parents: readonly MdNode[]) => "skip" | void): void {
  const walk = (node: MdNode, parents: MdNode[]) => {
    if (visitor(node, parents) === "skip") return;
    const children = (node as { children?: MdNode[] }).children;
    if (!Array.isArray(children)) return;
    const next = [...parents, node];
    for (const child of children) walk(child, next);
  };
  walk(tree, []);
}

/** A node's text, as `mdast-util-to-string` reads it: values, image alt, HTML included. */
export function toString(node: unknown): string {
  if (Array.isArray(node)) return node.map(toString).join("");
  if (!node || typeof node !== "object") return "";
  const value = node as { value?: unknown; alt?: unknown; children?: unknown };
  if ("value" in value) return String(value.value);
  if (typeof value.alt === "string" && value.alt) return value.alt;
  if ("children" in value) return toString(value.children);
  return "";
}

const PHRASING = new Set([
  "break",
  "delete",
  "emphasis",
  "footnote",
  "footnoteReference",
  "image",
  "imageReference",
  "inlineCode",
  "inlineMath",
  "link",
  "linkReference",
  "mdxJsxTextElement",
  "mdxTextExpression",
  "strong",
  "text",
  "textDirective",
]);
const phrasing = (node: MdNode) => PHRASING.has(node.type);

const HTML_HEADING = /<h([1-6])/;
const JSX_HEADING = /^h([1-6])$/;

function isJsxHeading(node: MdNode): boolean {
  const name = (node as { name?: unknown }).name;
  return (
    (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") &&
    typeof name === "string" &&
    JSX_HEADING.test(name)
  );
}

/** A heading's rank: a Markdown heading, an HTML `<hN>`, or an MDX `<hN>`. */
function rank(node: MdNode): number | undefined {
  if (node.type === "heading") return (node as { depth?: number }).depth;
  if (node.type === "html") {
    const match = String((node as { value?: unknown }).value).match(HTML_HEADING);
    return match ? Number(match[1]) : undefined;
  }
  if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
    const name = (node as { name?: unknown }).name;
    const match = typeof name === "string" ? name.match(JSX_HEADING) : null;
    return match ? Number(match[1]) : undefined;
  }
  return undefined;
}

function at(node: MdNode): RuleReport {
  const start = node.position?.start as Point | undefined;
  const end = node.position?.end as Point | undefined;
  const report: RuleReport = {
    message: "",
    line: typeof start?.line === "number" ? start.line : 1,
    column: typeof start?.column === "number" ? start.column : 1,
  };
  if (typeof end?.line === "number" && typeof end.column === "number") {
    report.endLine = end.line;
    report.endColumn = end.column;
  }
  return report;
}

/** Every top-level heading after the first. */
export function multipleTopLevelHeadings(tree: MdRoot): RuleReport[] {
  const reports: RuleReport[] = [];
  let seen = false;
  visitParents(tree, (node) => {
    if (rank(node) !== 1 || !node.position) return;
    if (seen) reports.push(at(node));
    else seen = true;
  });
  return reports;
}

/** Headings more than one level below the nearest heading above them. */
export function headingIncrement(tree: MdRoot): RuleReport[] {
  const reports: RuleReport[] = [];
  const stack: Array<MdNode | undefined> = [];
  visitParents(tree, (node) => {
    const level = rank(node);
    if (!level) return;
    let index = level;
    let parent: MdNode | undefined;
    while (index--) {
      if (stack[index]) {
        parent = stack[index];
        break;
      }
    }
    if (parent && node.position && level > rank(parent)! + 1) reports.push(at(node));
    stack[level] = node;
    stack.length = level + 1;
  });
  return reports;
}

const FENCE = /^ {0,3}([~`])\1{2,}/;

/** Fenced code blocks with no language. */
export function fencedCodeWithoutLanguage(tree: MdRoot, source: string): RuleReport[] {
  const reports: RuleReport[] = [];
  visitParents(tree, (node) => {
    if (phrasing(node)) return "skip";
    if (node.type !== "code") return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (typeof start !== "number" || typeof end !== "number") return;
    if ((node as { lang?: string | null }).lang) return;
    if (FENCE.test(source.slice(start, end))) reports.push(at(node));
  });
  return reports;
}

/** Headings, Markdown or MDX, whose last character matches `disallowed`. */
export function headingPunctuation(tree: MdRoot, disallowed: RegExp): RuleReport[] {
  const reports: RuleReport[] = [];
  visitParents(tree, (node) => {
    if (!node.position || (node.type !== "heading" && !isJsxHeading(node))) return;
    const tail = Array.from(toString(node)).at(-1);
    if (tail && disallowed.test(tail)) reports.push(at(node));
  });
  return reports;
}

/** Headings, Markdown or MDX, whose text (case-insensitively) an earlier heading already has. */
export function duplicateHeadings(tree: MdRoot): RuleReport[] {
  const reports: RuleReport[] = [];
  const seen = new Set<string>();
  visitParents(tree, (node) => {
    if (node.type !== "heading" && !isJsxHeading(node)) return;
    const text = toString(node).toLowerCase();
    if (node.position && seen.has(text)) reports.push(at(node));
    seen.add(text);
  });
  return reports;
}

/** Unordered list items whose marker isn't `expected`, at the marker. */
export function unorderedListMarker(tree: MdRoot, source: string, expected: "-" | "*" | "+"): RuleReport[] {
  const reports: RuleReport[] = [];
  visitParents(tree, (node, parents) => {
    if (phrasing(node)) return "skip";
    if (node.type !== "listItem") return;
    const parent = parents.at(-1);
    if (!parent || parent.type !== "list" || (parent as { ordered?: boolean }).ordered) return;
    const start = node.position?.start as Point | undefined;
    if (typeof start?.offset !== "number") return;
    const actual = source[start.offset];
    if ((actual === "*" || actual === "+" || actual === "-") && actual !== expected) {
      reports.push({
        message: "",
        line: typeof start.line === "number" ? start.line : 1,
        column: typeof start.column === "number" ? start.column : 1,
      });
    }
  });
  return reports;
}

/** Emphasis delimited by the other marker than `expected`. */
export function emphasisMarker(tree: MdRoot, source: string, expected: "*" | "_"): RuleReport[] {
  const reports: RuleReport[] = [];
  visitParents(tree, (node) => {
    if (node.type !== "emphasis") return;
    const start = node.position?.start.offset;
    if (typeof start !== "number") return;
    const actual = source.charAt(start);
    if ((actual === "*" || actual === "_") && actual !== expected) reports.push(at(node));
  });
  return reports;
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

/** Links whose text is their URL and that don't open with a marker: GFM autolink literals. */
export function literalUrls(tree: MdRoot, source: string): RuleReport[] {
  const reports: RuleReport[] = [];
  visitParents(tree, (node) => {
    if (node.type !== "link") return;
    const start = node.position?.start.offset;
    if (typeof start !== "number") return;
    const raw = toString(node);
    const url = (node as { url?: string }).url;
    const literal = raw === url || "http://" + raw === url || "mailto:" + raw === url;
    if (literal && !ASCII_PUNCTUATION.test(source.charAt(start))) reports.push(at(node));
  });
  return reports;
}
