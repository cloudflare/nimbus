/**
 * Pure collation for the full-corpus markdown document (`llms-full.txt`).
 *
 * Kept astro-free so the collation contract — ordering, separators, header
 * shape — is unit-testable without a build. `renderCorpusMarkdown()` in the
 * public entry maps `IndexedEntry[]` onto these blocks and applies the
 * version/hidden filtering; this module only formats.
 */

export interface CorpusBlock {
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

export interface CorpusHeader {
  /** Site title — the document's opening `#` heading. */
  title: string;
  /** Optional site description — blockquote under the opening heading. */
  description?: string | undefined;
  /**
   * Absolute site origin used to absolutize URLs. When absent, URLs are
   * emitted site-relative (dev builds without `site` still work).
   */
  site?: string | undefined;
}

/**
 * Collate corpus blocks into one markdown document.
 *
 * Contract:
 *   - Blocks are sorted by `url` — output is deterministic for a given
 *     input set regardless of collection iteration order.
 *   - Each block opens with a `#`-level heading. Page bodies render at
 *     `##` and below, so top-level headings unambiguously delimit entries.
 *   - The header cross-references the sitewide index (`/llms.txt`), making
 *     the index ↔ corpus pair mutually discoverable.
 *   - No timestamps, no build metadata — byte-identical across rebuilds.
 */
export function buildCorpusMarkdown(
  blocks: CorpusBlock[],
  header: CorpusHeader,
): string {
  const abs = (p: string): string =>
    header.site ? new URL(p, header.site).href : p;

  const lines: string[] = [`# ${header.title}`, ""];
  if (header.description) lines.push(`> ${header.description}`, "");
  lines.push(`Index: ${abs("/llms.txt")}`, "");

  const sorted = [...blocks].sort((a, b) => a.url.localeCompare(b.url));
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
