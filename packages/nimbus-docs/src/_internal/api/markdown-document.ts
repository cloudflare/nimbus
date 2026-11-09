/**
 * The one serialization of an API page's Markdown document: the emitter over
 * the page's view model, root-relative links made absolute, and the envelope
 * (frontmatter, the index note, the title, a `Source:` line). The build's
 * bake and the request path both call this, so a request renders the same
 * bytes the bake would have written for the same build. Runtime-safe: the
 * parser is `mdast-util-from-markdown`, which the emitter already uses.
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { absolutizeMarkdownLinks, type MdastNode } from "../markdown-links.js";
import { withBase } from "../url.js";
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

export function absoluteSiteUrl(site: string, base: string, pathname: string): string {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(pathname)) return pathname;
  const prefix = base === "/" ? "" : base.replace(/\/+$/u, "");
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return new URL(`${prefix}${normalized}`, site).href;
}

// API titles come from spec summaries, which can span lines; a line break in a
// `# title` would start a new heading.
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// GFM, as the authored pages' parser reads: a `|` splits a table cell before
// a code span can span it, so links sit where a GFM reader sees them.
const parse = (source: string) =>
  fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as unknown as MdastNode;

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
