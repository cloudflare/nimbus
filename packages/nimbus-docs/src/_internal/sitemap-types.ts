/**
 * Types for the public `SitemapOptions.serialize` hook.
 *
 * These mirror `@astrojs/sitemap`'s `SitemapItem` shape but are declared
 * locally so the public option type doesn't depend on that integration's
 * internals.
 */

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
