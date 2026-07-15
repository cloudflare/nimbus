/**
 * Layer 4 — sitemap emission.
 *
 * When incremental builds are on, the cache layer filters cached routes
 * from Astro's render pipeline. Downstream integrations that hook
 * `astro:build:done` (including `@astrojs/sitemap`) only see the dirty
 * subset in their `pages` argument. The sitemap they emit is missing all
 * cached routes — broken on every warm build.
 *
 * Fix: don't register `@astrojs/sitemap` at all when incremental is on.
 * Instead, this module emits the sitemap directly from the union of
 * (Astro's `pages` arg) and (incrementalCtx's cached pathnames).
 *
 * Output is **structurally compatible** with `@astrojs/sitemap`'s default
 * output — same xmlns set, same element shape, same sorted-URL invariant
 * — but isn't bit-identical to the upstream emitter. Specifically:
 *
 *   - XML entity escaping uses `&apos;` for single quotes where upstream
 *     uses `&#39;`. Functionally identical; lexically different.
 *   - `@astrojs/sitemap` adds an XML declaration newline upstream's
 *     serializer happens to insert; we don't.
 *
 * The shape that DOES hold across cold and warm builds of *this*
 * emitter is byte-identical (same URL set, same sort, same escape
 * table). Cold-vs-warm parity is the property the cache layer needs;
 * upstream-byte-parity is only relevant for sites comparing against
 * a non-incremental build of `@astrojs/sitemap`.
 *
 * Format details:
 *   - One line, no whitespace between elements
 *   - URLs sorted alphabetically by absolute URL
 *   - Directory-format trailing slash (`/foo/` not `/foo`)
 *   - xmlns declarations matching @astrojs/sitemap's set
 *   - sitemap-0.xml carries all entries (we don't split until >45k urls)
 *   - sitemap-index.xml lists sitemap-0.xml only
 *
 * Scope: an optional `serialize` hook per URL, but no `lastmod`,
 * `changefreq`, `priority`, and no image/video sitemaps. Matches
 * `@astrojs/sitemap` *default* output for sites that don't override.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Mirror of `@astrojs/sitemap`'s `SitemapItem` shape. */
export interface SitemapItem {
  url: string;
  lastmod?: string;
  changefreq?:
    | "always"
    | "hourly"
    | "daily"
    | "weekly"
    | "monthly"
    | "yearly"
    | "never";
  priority?: number;
  links?: { lang: string; url: string }[];
}

export type SitemapSerialize = (
  item: SitemapItem,
) => SitemapItem | undefined | null | Promise<SitemapItem | undefined | null>;

export interface IncrementalSitemapOptions {
  /** Absolute site URL, no trailing slash. e.g. `https://example.com`. */
  siteUrl: string;
  /** Astro's `astro:build:done` `pages` argument — routes Astro just built. */
  builtPages: Array<{ pathname: string }>;
  /** Cached pathnames from the incremental context (no trailing slash). */
  cachedPathnames: Iterable<string>;
  /** Dist directory absolute path. */
  distDir: string;
  /** Optional `base` prefix from Astro config. */
  base?: string;
  /**
   * User-supplied serialize function. Called for every URL — cached and
   * dirty alike — so warm-build sitemap matches cold-build sitemap when the
   * site uses a serializer (a git-sourced `lastmod` pattern is the
   * motivating case). Returning `null`/`undefined` drops the entry.
   * If absent, the entry is emitted as `<url><loc>...</loc></url>` only.
   */
  serialize?: SitemapSerialize;
  /**
   * Extra URLs that aren't routes — e.g. external pages the site links to.
   * Mirrors `@astrojs/sitemap`'s `customPages`.
   */
  customPages?: string[];
}

const URLSET_XMLNS =
  'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"' +
  ' xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"' +
  ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' +
  ' xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"' +
  ' xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"';

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") && s.length > 1 ? s.slice(0, -1) : s;
}

function ensureTrailingSlash(s: string): string {
  return s.endsWith("/") ? s : s + "/";
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the canonical URL set. Astro's `pages` arg gives us pathnames as
 * `foo/bar/` style (already trailing-slash for directory format). The
 * cached pathnames from the incremental context are canonical-form
 * (no trailing slash). Normalise both, dedupe, sort.
 */
function buildUrlSet(opts: IncrementalSitemapOptions): string[] {
  const siteRoot = trimTrailingSlash(opts.siteUrl);
  const base = opts.base ? trimTrailingSlash(opts.base) : "";
  const pathnames = new Set<string>();

  for (const page of opts.builtPages) {
    // Astro provides pathname without leading slash, with trailing slash.
    // Normalise to absolute URL.
    const path = ensureTrailingSlash("/" + page.pathname.replace(/^\/+/, ""));
    pathnames.add(`${siteRoot}${base}${path}`);
  }
  for (const cached of opts.cachedPathnames) {
    // Canonical form: "/foo/bar" or "/". We want trailing slash for
    // directory format.
    const withSlash = cached === "/" ? "/" : ensureTrailingSlash(cached);
    pathnames.add(`${siteRoot}${base}${withSlash}`);
  }

  return Array.from(pathnames).sort();
}

function renderItem(item: SitemapItem): string {
  let inner = `<loc>${xmlEscape(item.url)}</loc>`;
  if (item.lastmod !== undefined) inner += `<lastmod>${xmlEscape(item.lastmod)}</lastmod>`;
  if (item.changefreq !== undefined) inner += `<changefreq>${xmlEscape(item.changefreq)}</changefreq>`;
  if (item.priority !== undefined) inner += `<priority>${item.priority}</priority>`;
  if (item.links && item.links.length > 0) {
    for (const link of item.links) {
      inner += `<xhtml:link rel="alternate" hreflang="${xmlEscape(link.lang)}" href="${xmlEscape(link.url)}"/>`;
    }
  }
  return `<url>${inner}</url>`;
}

export async function emitIncrementalSitemap(
  opts: IncrementalSitemapOptions,
): Promise<{ urlCount: number }> {
  const urls = buildUrlSet(opts);
  if (opts.customPages) {
    for (const extra of opts.customPages) urls.push(extra);
  }
  if (urls.length === 0) {
    return { urlCount: 0 };
  }
  urls.sort();

  // Apply the user serializer to every URL. Returning null/undefined drops
  // the entry.
  const items: SitemapItem[] = [];
  for (const url of urls) {
    let item: SitemapItem | null | undefined = { url };
    if (opts.serialize) {
      item = await opts.serialize(item);
    }
    if (item) items.push(item);
  }

  const urlEntries = items.map(renderItem).join("");
  const sitemap0 =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<urlset ${URLSET_XMLNS}>${urlEntries}</urlset>`;

  const siteRoot = trimTrailingSlash(opts.siteUrl);
  const base = opts.base ? trimTrailingSlash(opts.base) : "";
  const sitemap0Loc = `${siteRoot}${base}/sitemap-0.xml`;
  const sitemapIndex =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    `<sitemap><loc>${xmlEscape(sitemap0Loc)}</loc></sitemap>` +
    `</sitemapindex>`;

  await mkdir(opts.distDir, { recursive: true });
  await writeFile(resolve(opts.distDir, "sitemap-0.xml"), sitemap0, "utf8");
  await writeFile(resolve(opts.distDir, "sitemap-index.xml"), sitemapIndex, "utf8");

  return { urlCount: items.length };
}
