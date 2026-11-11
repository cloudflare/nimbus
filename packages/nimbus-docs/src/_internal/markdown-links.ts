/**
 * Make root-relative link and image URLs in generated Markdown absolute
 * against a site origin, so they resolve wherever the Markdown is read.
 * Parser-agnostic: the caller supplies the mdast parser (Sätteri for authored
 * pages, `mdast-util-from-markdown` for API pages, which must also run in a
 * Worker). Fragment, relative and external URLs, and anything inside code,
 * stay as written.
 */

export interface MdastNode {
  type: string;
  children?: MdastNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  [key: string]: unknown;
}

export type MdastParser = (source: string) => MdastNode;

export function walkMdast(node: MdastNode, visit: (node: MdastNode) => void): void {
  visit(node);
  node.children?.forEach((child) => walkMdast(child, visit));
}

export function absolutizeMarkdownLinks(markdown: string, site: string, parse: MdastParser): string {
  if (!/\]\(|\]:/.test(markdown)) return markdown;
  const origin = new URL(site).origin;
  // Offsets where the origin goes: the start of each destination as written,
  // so escapes, entities and titles keep their bytes.
  const inserts = new Set<number>();
  walkMdast(parse(markdown), (node) => {
    if (node.type !== "link" && node.type !== "image" && node.type !== "definition") return;
    const url = node.url;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) return;
    if (start === undefined || end === undefined) return;
    const at = destinationStart(markdown, start, end, node.type, url, parse);
    if (at !== undefined) inserts.add(at);
  });
  let out = markdown;
  for (const at of [...inserts].sort((a, b) => b - a)) out = out.slice(0, at) + origin + out.slice(at);
  return out;
}

const PROBE = "https://nimbus.invalid";

/**
 * Where the destination of the node at `start`–`end` begins in `markdown`.
 * Each `](` (or `]:`) inside the node is a candidate; the parser confirms the
 * one where an origin placed there becomes part of the URL, so a `](` in a
 * label, alt text, code span or title is never the one rewritten. The node's
 * own text is tried first; a node that needs its context (a link wrapped
 * inside a blockquote) is tried from the start of its line, with the
 * container markers that line carries, and then in the whole document.
 */
function destinationStart(
  markdown: string,
  start: number,
  end: number,
  type: string,
  url: string,
  parse: MdastParser,
): number | undefined {
  const text = markdown.slice(start, end);
  // The node from the start of its line, so a blockquote's or list's
  // markers come with it; the slice stays the size of the node.
  const lineStart = markdown.lastIndexOf("\n", start - 1) + 1;
  const context = markdown.slice(lineStart, end);
  // `source` holds the node at `offset`; the probe goes in at `at` within it.
  const confirms = (source: string, offset: number, at: number) => {
    let found = false;
    walkMdast(parse(source.slice(0, at) + PROBE + source.slice(at)), (node) => {
      if (node.type === type && node.position?.start.offset === offset && node.url === PROBE + url) found = true;
    });
    return found;
  };
  const candidates: number[] = [];
  const marker = type === "definition" ? "]:" : "](";
  for (let i = text.indexOf(marker); i >= 0; i = text.indexOf(marker, i + 1)) {
    let at = i + 2;
    while (" \t\r\n>".includes(text[at] ?? "x")) at++;
    if (text[at] === "<") at++;
    candidates.push(at);
  }
  for (const at of candidates) if (confirms(text, 0, at)) return start + at;
  const offset = start - lineStart;
  for (const at of candidates) if (confirms(context, offset, offset + at)) return start + at;
  // Containers opened on earlier lines (a list inside a blockquote): the whole
  // document, which only such nesting needs.
  for (const at of candidates) if (confirms(markdown, start, start + at)) return start + at;
  return undefined;
}
