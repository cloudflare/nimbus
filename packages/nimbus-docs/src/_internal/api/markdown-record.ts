/**
 * An API page's Markdown made on request, from the page record the Worker
 * already renders HTML from: the prepared entry of a bundled collection, or
 * the page pack of a `bundle: false` one. The document goes through the same
 * serialization the bake uses (`markdown-document.ts`).
 */

import type { ApiPageProps } from "./api-view-types.js";
import {
  markdownUrlOf,
  renderApiMarkdownDocument,
  type ApiMarkdownDocument,
} from "./markdown-document.js";

/**
 * A request-rendered API page the build describes instead of baking: enough
 * to resolve a request and reproduce the envelope. Kept in the agent-endpoint
 * manifest.
 */
export interface RenderedMarkdownPage {
  collection: string;
  /** The content entry id (a page pack's slug, `index` for the root). */
  id: string;
  /** The API version the record lives under; `null` for an unversioned API. */
  version: string | null;
  /** The page's coordinate in its API model. */
  coordinate: string;
  title: string;
  /** The page's own social image, when the entry sets one. */
  image?: string;
  /** The page URL, site-relative, in document form. */
  url: string;
  /** Whether a route of the site serves the page's `.md`; the body is kept for MCP either way. */
  published: boolean;
}

export interface RenderedMarkdownPayload {
  collection: string;
  id: string;
  surface: "markdown";
  digest: string;
  mediaType: string;
  body: string;
  content: string;
}

/** The `.md` path a descriptor answers at, published or not. */
export function renderedMarkdownPath(page: RenderedMarkdownPage): string {
  return markdownUrlOf(page.url);
}

/** The page record, the way the HTML route reads it. */
export async function loadApiPageRecord(
  page: Pick<RenderedMarkdownPage, "collection" | "id" | "version" | "coordinate">,
  request?: Request,
): Promise<ApiPageProps> {
  const { hasApiPageAssets, getApiAssetPage } = await import("./page-assets-runtime.js");
  if (await hasApiPageAssets(page.collection)) {
    return (await getApiAssetPage(page.collection, page.version, page.coordinate, request)).page;
  }
  const { getEntry } = await import("astro:content");
  const entry = (await getEntry(page.collection as never, page.id as never)) as
    | { data?: { prepared?: unknown } }
    | undefined;
  const { isPreparedApiPage } = await import("./prepared.js");
  if (entry && isPreparedApiPage(entry.data?.prepared)) return entry.data.prepared.page;
  // Thin entries: project the page from the configured model.
  const { projectConfiguredApiPageProps } = await import("../api-projector.js");
  return projectConfiguredApiPageProps(page.collection, page.version, page.coordinate);
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The serialization inputs the request path reads from the site's runtime config. */
async function siteForRequest() {
  const [{ options }, { loadNimbusConfig }, { publishedAgentUrls }] = await Promise.all([
    import("virtual:nimbus/agent-capabilities"),
    import("../runtime-config.js"),
    import("../agent-surfaces-runtime.js"),
  ]);
  const [config, publishes] = await Promise.all([loadNimbusConfig(), publishedAgentUrls()]);
  return {
    site: options.site,
    base: options.base,
    ...(config.socialImage ? { socialImage: config.socialImage } : {}),
    publishes,
  };
}

/** Render a described page's Markdown document now. */
export async function renderMarkdownDocument(
  page: RenderedMarkdownPage,
  request?: Request,
): Promise<ApiMarkdownDocument> {
  const [record, site] = await Promise.all([loadApiPageRecord(page, request), siteForRequest()]);
  return renderApiMarkdownDocument(
    record,
    {
      collection: page.collection,
      id: page.id,
      title: page.title,
      ...(page.version ? { version: page.version } : {}),
      ...(page.image ? { image: page.image } : {}),
      url: page.url,
    },
    site,
  );
}

/** The payload a Markdown route or MCP reads for a described page. */
export async function renderMarkdownPayload(
  page: RenderedMarkdownPage,
  request?: Request,
): Promise<RenderedMarkdownPayload> {
  const document = await renderMarkdownDocument(page, request);
  return {
    collection: page.collection,
    id: page.id,
    surface: "markdown",
    digest: `sha256:${await sha256(document.body)}`,
    mediaType: "text/markdown; charset=utf-8",
    body: document.body,
    content: document.content,
  };
}
