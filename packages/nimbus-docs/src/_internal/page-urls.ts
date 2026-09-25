import { entryRouteUrl } from "./astro-slug.js";
import { toBrowserHref } from "./url.js";

/**
 * Site-relative URLs (no base path) for one content entry, derived from the
 * route Astro serves it at. `IndexedEntry` and the page helpers both read
 * these, so a page's links always match the files the routes emit.
 */
export interface PageUrls {
  url: string;
  markdownUrl: string;
  sourceUrl: string | undefined;
  ogImageUrl: string;
}

const OG_IMAGE_ROUTE = "/og/";

/** `ogImageUrl` is `/og/<route>.png`, with `index` for the site root. */
export function pageUrls(
  prefix: string,
  entry: { id: string; body?: unknown },
): PageUrls {
  const route = entryRouteUrl(prefix, entry.id);
  const page = route === "/" ? "" : route;
  return {
    url: toBrowserHref(route),
    markdownUrl: `${page}/index.md`,
    sourceUrl:
      typeof entry.body === "string" && entry.body.length > 0
        ? `${page}/index.mdx`
        : undefined,
    ogImageUrl: `${OG_IMAGE_ROUTE}${page.slice(1) || "index"}.png`,
  };
}

/**
 * The astro-og-canvas `pages` key whose card is written at `ogImageUrl`. The
 * key keeps `.png` because astro-og-canvas's default slug replaces a key's
 * last extension: an extensionless `v1.2/guide` would lose `.2/guide`.
 */
export function ogImagePageKey(ogImageUrl: string): string {
  return ogImageUrl.slice(OG_IMAGE_ROUTE.length);
}
