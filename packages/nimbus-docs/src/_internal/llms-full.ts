/**
 * Pure collation for the full-documentation Markdown file (`llms-full.txt`).
 *
 * Kept astro-free so the collation contract — ordering, separators, header
 * shape — is unit-testable without a build. `renderLlmsFullMarkdown()` in the
 * public entry maps `IndexedEntry[]` onto these blocks and applies the
 * version/hidden filtering; this module only formats.
 */

import { isAbsoluteUrl } from "./url.js";

export interface LlmsFullBlock {
  /** Display title — becomes the block's `#`-level heading. */
  title: string;
  /** Optional description — rendered as a blockquote under the heading. */
  description?: string | undefined;
  /** Site-relative page URL; also the deterministic sort key. */
  url: string;
  /** Site-relative URL of the page's `.md` alternate. */
  markdownUrl: string;
  /** The page body as clean markdown (already downleveled). */
  markdown: string;
}

export interface LlmsFullHeader {
  /** Site title — the document's opening `#` heading. */
  title: string;
  /** Optional site description — blockquote under the opening heading. */
  description?: string | undefined;
  /**
   * Absolute site origin used to absolutize URLs. When absent, URLs are
   * emitted site-relative (dev builds without `site` still work).
   */
  site?: string | undefined;
  /** Astro base path applied before URLs are made absolute. */
  base?: string | undefined;
}

/**
 * Collate prepared page blocks into one Markdown document.
 *
 * Contract:
 *   - Blocks are sorted by `url` — output is deterministic for a given
 *     input set regardless of collection iteration order.
 *   - Each block opens with a `#`-level heading. Page bodies render at
 *     `##` and below, so top-level headings unambiguously delimit entries.
 *   - The header cross-references the sitewide index (`/llms.txt`), making
 *     the index and full documentation mutually discoverable.
 *   - No timestamps, no build metadata — byte-identical across rebuilds.
 */
export function buildLlmsFullMarkdown(
  blocks: LlmsFullBlock[],
  header: LlmsFullHeader,
): string {
  const abs = (p: string): string => {
    const base = header.base ?? "/";
    let end = base.length;
    while (end > 0 && base[end - 1] === "/") end--;
    const prefix = base.slice(0, end);
    const based =
      isAbsoluteUrl(p) || p.startsWith("#") || p.startsWith("?") || !prefix
        ? p
        : `${prefix}${p.startsWith("/") ? p : `/${p}`}`;
    return header.site ? new URL(based, header.site).href : based;
  };

  const lines: string[] = [`# ${header.title}`, ""];
  if (header.description) lines.push(`> ${header.description}`, "");
  lines.push(`Index: ${abs("/llms.txt")}`, "");

  const sorted = [...blocks].sort((a, b) =>
    a.url < b.url ? -1 : a.url > b.url ? 1 : 0,
  );
  for (const block of sorted) {
    lines.push(`# ${block.title}`, "");
    if (block.description) lines.push(`> ${block.description}`, "");
    lines.push(
      `Source: ${abs(block.url)} · Markdown: ${abs(block.markdownUrl)}`,
      "",
      block.markdown,
      "",
    );
  }

  return lines.join("\n");
}
