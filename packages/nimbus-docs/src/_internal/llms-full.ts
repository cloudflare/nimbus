/**
 * Pure collation for the full-documentation Markdown file (`llms-full.txt`).
 *
 * Kept astro-free so the collation contract — ordering, separators, header
 * shape — is unit-testable without a build. `renderLlmsFullMarkdown()` in the
 * public entry maps `IndexedEntry[]` onto these blocks and applies the
 * version/hidden filtering; this module only formats.
 */

import { compareByPosition } from "./llms-order.js";
import { isAbsoluteUrl } from "./url.js";

export interface LlmsFullBlock {
  /** Display title — becomes the block's `#`-level heading. */
  title: string;
  /** Optional description — rendered as a blockquote under the heading. */
  description?: string | undefined;
  /** Site-relative page URL; the sort key after `position`. */
  url: string;
  /** The page's place in the sidebar's reading order, when the sidebar shows it. */
  position?: number;
  /** Site-relative URL of the page's `.md` alternate. */
  markdownUrl: string;
  /** The page body as clean markdown (already downleveled). */
  markdown: string;
}

/** An API page's block. Its Markdown already prints the description, and its
 * title comes from a spec summary that can span lines, which would start a new
 * heading. */
export function apiLlmsFullBlock(block: LlmsFullBlock): LlmsFullBlock {
  return { ...block, title: block.title.replace(/\s+/g, " ").trim(), description: undefined };
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
  /** The `llms.txt` the header links to. Default `/llms.txt`. */
  index?: string | undefined;
}

/**
 * Collate prepared page blocks into one Markdown document.
 *
 * Contract:
 *   - Blocks follow the sidebar's reading order (`position`), then `url` —
 *     output is deterministic for a given input set regardless of
 *     collection iteration order.
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
  const sorted = [...blocks].sort(compareByPosition);
  // Each part ends in a blank line; the document ends with one newline.
  return (
    llmsFullHeaderText(header) +
    sorted.map((block) => llmsFullBlockText(block, header)).join("")
  ).slice(0, -1);
}

/**
 * Bytes `block` adds to a document with this header. A document's size is
 * its header's bytes plus its blocks', minus one (the final blank line).
 */
export function llmsFullBlockBytes(block: LlmsFullBlock, header: LlmsFullHeader): number {
  return utf8Bytes(llmsFullBlockText(block, header));
}

/** Bytes of the document's header (see {@link llmsFullBlockBytes}). */
export function llmsFullHeaderBytes(header: LlmsFullHeader): number {
  return utf8Bytes(llmsFullHeaderText(header));
}

const encoder = new TextEncoder();
function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** `path` as a URL in the document: under the base, absolute with a site. */
export function llmsFullUrl(header: LlmsFullHeader, p: string): string {
  const base = header.base ?? "/";
  let end = base.length;
  while (end > 0 && base[end - 1] === "/") end--;
  const prefix = base.slice(0, end);
  const based =
    isAbsoluteUrl(p) || p.startsWith("#") || p.startsWith("?") || !prefix
      ? p
      : `${prefix}${p.startsWith("/") ? p : `/${p}`}`;
  return header.site ? new URL(based, header.site).href : based;
}

function llmsFullHeaderText(header: LlmsFullHeader): string {
  const lines: string[] = [`# ${header.title}`, ""];
  if (header.description) lines.push(`> ${header.description}`, "");
  lines.push(`Index: ${llmsFullUrl(header, header.index ?? "/llms.txt")}`, "");
  return `${lines.join("\n")}\n`;
}

function llmsFullBlockText(block: LlmsFullBlock, header: LlmsFullHeader): string {
  const lines: string[] = [`# ${block.title}`, ""];
  if (block.description) lines.push(`> ${block.description}`, "");
  lines.push(
    `Source: ${llmsFullUrl(header, block.url)} · Markdown: ${llmsFullUrl(header, block.markdownUrl)}`,
    "",
  );
  // A page with no body adds no blank run.
  if (block.markdown.trim()) lines.push(block.markdown, "");
  return `${lines.join("\n")}\n`;
}
