/**
 * Collect headings from *rendered* HTML — for headings emitted at runtime
 * (e.g. via `set:html`) that never appear in compile-time
 * `render().headings`. See {@link getHeadingsFromHtml}.
 */

import type { Heading } from "./partial-headings.js";

const HEADING = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;
const ID_ATTR = /\bid=["']([^"']+)["']/i;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
};

// Strip tags to completion: a single pass can leave a reconstructable tag
// for nested inputs (e.g. `<sc<script>ript>`), so repeat until stable.
function stripTags(html: string): string {
  let out = html;
  let previous: string;
  do {
    previous = out;
    out = out.replace(/<[^>]*>/g, "");
  } while (out !== previous);
  return out;
}

function toText(inner: string): string {
  return stripTags(inner)
    .replace(/&(?:amp|lt|gt|quot|nbsp|#39|#x27);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
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
