import { entryRouteUrl } from "./astro-slug.js";
import { toDocumentHref } from "./url.js";

/**
 * Site-relative URLs (no base path) for one content entry, derived from the
 * route Astro serves it at. `IndexedEntry` and the page helpers both read
 * these, so a page's links always match the files the routes emit.
 */
export interface PageUrls {
  url: string;
  /** `undefined` when no route of the site serves the page's `.md` URL. */
  markdownUrl: string | undefined;
  sourceUrl: string | undefined;
  ogImageUrl: string;
}

const OG_IMAGE_ROUTE = "/og/";

/**
 * Nimbus's generated cards, which `NimbusHead` recognises by logical path:
 * the site card at `/og.png` and one `/og/<route>.png` per page, all at the
 * starter's card size.
 */
export const OG_CARD = {
  sitePath: "/og.png",
  pagePrefix: OG_IMAGE_ROUTE,
  size: { width: 1200, height: 630 },
} as const;

/**
 * `ogImageUrl` is `/og/<route>.png`, with `index` for the site root.
 * `publishes` says whether a route of the site serves a `.md` or `.mdx` URL;
 * without it every alternate is taken as served.
 */
export function pageUrls(
  prefix: string,
  entry: { id: string; body?: unknown; filePath?: string },
  publishes: (url: string) => boolean = () => true,
): PageUrls {
  const route = entryRouteUrl(prefix, entry.id);
  const page = route === "/" ? "" : route;
  const markdownUrl = `${page}/index.md`;
  const sourceUrl = `${page}/index.mdx`;
  return {
    url: toDocumentHref(route),
    markdownUrl: publishes(markdownUrl) ? markdownUrl : undefined,
    // A frontmatter-only Markdown file has no body but still has a source.
    sourceUrl:
      ((typeof entry.body === "string" && entry.body.length > 0) || /\.mdx?$/iu.test(entry.filePath ?? "")) &&
      publishes(sourceUrl)
        ? sourceUrl
        : undefined,
    ogImageUrl: `${OG_IMAGE_ROUTE}${page.slice(1) || "index"}.png`,
  };
}

/**
 * The `getOgImagePages()` key whose card is written at `ogImageUrl`: its path
 * under `/og/`, `.png` included. The starter's OG route passes it through as
 * the `slug` parameter, so a dotted `v1.2/guide.png` keeps its dots.
 */
export function ogImagePageKey(ogImageUrl: string): string {
  return ogImageUrl.slice(OG_IMAGE_ROUTE.length);
}
