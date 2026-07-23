/**
 * Collect headings from *rendered* HTML — for headings emitted at runtime
 * (e.g. via `set:html`) that never appear in compile-time
 * `render().headings`. See {@link getHeadingsFromHtml}.
 */

import type { Heading } from "./partial-headings.js";

const HEADING = /<h([1-6])\b([^<>]*)>([\s\S]*?)<\/h\1>/gi;
// Anchor to an attribute boundary so `data-id`/`data-section-id` can't be
// mistaken for `id` (attributes are whitespace-separated).
const ID_ATTR = /(?:^|\s)id=["']([^"']+)["']/i;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const cp =
        code[1]?.toLowerCase() === "x"
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

// Drop everything between `<` and `>` in a single linear pass. Depth-tracking
// handles nested/malformed inputs (e.g. `<sc<script>ript>`) without the
// backtracking or repeated scans a regex approach would need.
function stripTags(html: string): string {
  let out = "";
  let depth = 0;
  for (const ch of html) {
    if (ch === "<") depth++;
    else if (ch === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

function toText(inner: string): string {
  return decodeEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
}

/**
 * Parse `<h1>`–`<h6>` elements (with an `id`) out of an HTML string into a
 * flat, document-ordered heading list suitable for {@link getTOC}.
 *
 * @param html - Rendered HTML (e.g. from `container.renderToString(Content)`).
 * @returns Headings in source order: `{ depth, text, slug }`.
 */
export function getHeadingsFromHtml(html: string): Heading[] {
  const headings: Heading[] = [];
  if (!html) return headings;

  for (const match of html.matchAll(HEADING)) {
    const depth = Number(match[1]);
    const attrs = match[2] ?? "";
    const idMatch = ID_ATTR.exec(attrs);
    if (!idMatch) continue;

    const slug = idMatch[1]!;
    if (slug === "footnote-label") continue;

    headings.push({ depth, slug, text: toText(match[3] ?? "") });
  }

  return headings;
}
