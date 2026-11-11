/**
 * The one serialization of an API page's Markdown document: the emitter over
 * the page's view model, root-relative links made absolute, and the envelope
 * (frontmatter, the index note, the title, a `Source:` line). The build's
 * bake and the request path both call this, so a request renders the same
 * bytes the bake would have written for the same build. Runtime-safe: the
 * parser is `mdast-util-from-markdown`, which the emitter already uses.
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";
import { absolutizeMarkdownLinks, type MdastNode } from "../markdown-links.js";
import { absoluteSiteUrl, withBase } from "../url.js";
import type { ApiPageProps } from "./api-view-types.js";
import { renderApiPageMarkdown } from "./markdown.js";

/** What the envelope knows about the page, beyond its view model. */
export interface ApiMarkdownPageMeta {
  collection: string;
  id: string;
  /** The page's title as the entry carries it; the heading prints it on one line. */
  title: string;
  /** The API version the page documents, written to the frontmatter. */
  version?: string;
  /** The page's own social image, over the site's. */
  image?: string;
  /** The page URL, site-relative, in document form (`/api/pets/`). */
  url: string;
}

/** The site the document is written for. */
export interface ApiMarkdownSite {
  site: string;
  base: string;
  socialImage?: string;
  /** Whether a route of the site serves an agent URL (`/llms.txt`, the page's `.md`). */
  publishes: (url: string) => boolean;
}

export interface ApiMarkdownDocument {
  body: string;
  /** The emitter's Markdown: `body.slice(contentStart, contentEnd)`. */
  content: string;
  contentStart: number;
  contentEnd: number;
}

/** The `.md` URL of a page URL (`/api/pets/` → `/api/pets/index.md`). */
export function markdownUrlOf(pageUrl: string): string {
  const route = pageUrl.split("?")[0]!.replace(/\/+$/u, "");
  return route === "" ? "/index.md" : `${route}/index.md`;
}

// API titles come from spec summaries, which can span lines; a line break in a
// `# title` would start a new heading.
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// GFM tables and bare `www.` and `http` URLs, as the authored pages' parser
// reads them: a `|` splits a cell before a code span can span it, and a bare
// URL is a link, not text a `[` after it could start a link in, so links sit
// where a GFM reader sees them. Only the tokenizers ship: the links come out
// with their positions whether or not the tree has table or autolink nodes,
// and the mdast extensions would bring the whole Markdown serializer with them.
export const parseApiMarkdown = (source: string): MdastNode =>
  fromMarkdown(source, { extensions: [gfmTable(), gfmAutolinkLiteral()] }) as unknown as MdastNode;
const parse = parseApiMarkdown;

/** The "Documentation Index" note every page Markdown opens with, when a route serves `/llms.txt`. */
export function llmsIndexNoteLines(site: ApiMarkdownSite): string[] {
  if (!site.publishes("/llms.txt")) return [];
  return [
    "> Documentation Index",
    `> Fetch the complete documentation index at: ${absoluteSiteUrl(site.site, site.base, "/llms.txt")}`,
    "> Use this file to discover all available pages before exploring further.",
    "",
  ];
}

export function renderApiMarkdownDocument(
  page: ApiPageProps,
  meta: ApiMarkdownPageMeta,
  site: ApiMarkdownSite,
): ApiMarkdownDocument {
  const content = absolutizeMarkdownLinks(renderApiPageMarkdown(page, { base: site.base }), site.site, parse);
  const image = meta.image ?? site.socialImage;
  // API pages have no authored source, so the description is left out of the
  // frontmatter: the body prints it.
  const prefix = `${[
    "---",
    `title: ${JSON.stringify(meta.title)}`,
    ...(image ? [`image: ${JSON.stringify(new URL(withBase(image, site.base), site.site).href)}`] : []),
    ...(meta.version ? [`version: ${JSON.stringify(meta.version)}`] : []),
    "---",
    "",
    ...llmsIndexNoteLines(site),
    `# ${oneLine(meta.title)}`,
    "",
  ].join("\n")}\n`;
  // The source is the Markdown URL when a route serves it, else the page.
  const markdownUrl = markdownUrlOf(meta.url);
  const source = site.publishes(markdownUrl) ? markdownUrl : meta.url;
  const suffix = `\n${["", `Source: ${absoluteSiteUrl(site.site, site.base, source)}`, ""].join("\n")}`;
  return {
    body: `${prefix}${content}${suffix}`,
    content,
    contentStart: prefix.length,
    contentEnd: prefix.length + content.length,
  };
}
