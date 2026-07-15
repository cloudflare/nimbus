/**
 * URL helpers with two distinct inputs that must not be conflated:
 *
 *   - A RAW filesystem path (lint's `enumerateEntries`, incremental cache
 *     scan): Astro hasn't processed it, so replay its default slug
 *     normalization. Use `canonicalSlug` / `canonicalEntryUrl`.
 *   - A FINAL `entry.id` from the content store (sidebar, SEO, version
 *     alternates): the route helpers pass it verbatim as `params.slug`, so
 *     it must NOT be re-slugged. Use `entryRouteKey` / `entryRouteUrl`.
 */

import { slug as githubSlug } from "github-slugger";

/**
 * Replay Astro's default content-layer slug normalization on a raw
 * filesystem path: `github-slugger` per segment + trailing `/index` strip.
 * Does not see a `slug:` frontmatter override — callers holding a final
 * `entry.id` must use `entryRouteKey` instead.
 */
export function canonicalSlug(entryId: string): string {
  const slugged = entryId
    .split("/")
    .map((segment) => githubSlug(segment))
    .join("/");
  if (slugged === "index") return "";
  return slugged.endsWith("/index")
    ? slugged.slice(0, -"/index".length)
    : slugged;
}

/**
 * Compose the URL Astro serves for a raw filesystem path at a given
 * collection prefix (replays the default slug normalization).
 *
 *   canonicalEntryUrl("", "WIP/index")    → "/wip"
 *   canonicalEntryUrl("/blog", "first")   → "/blog/first"
 *   canonicalEntryUrl("/v1", "index")     → "/v1"
 */
export function canonicalEntryUrl(prefix: string, entryId: string): string {
  const slug = canonicalSlug(entryId);
  if (slug === "") return prefix === "" ? "/" : prefix;
  return `${prefix}/${slug}`;
}

/**
 * Route key for a final `entry.id`: the id verbatim, with only a trailing
 * `/index` collapsed. No re-slugging — `getDocsStaticPaths` routes on
 * `params.slug = entry.id`, so a `slug:` override like `1.1.1.1/encryption`
 * must be preserved exactly (re-slugging would map it to `1111/...`).
 *
 *   entryRouteKey("1.1.1.1/encryption")  → "1.1.1.1/encryption"
 *   entryRouteKey("a/b/index")           → "a/b"
 *   entryRouteKey("index")               → ""
 */
export function entryRouteKey(entryId: string): string {
  if (entryId === "index") return "";
  return entryId.endsWith("/index")
    ? entryId.slice(0, -"/index".length)
    : entryId;
}

/**
 * Compose the served URL for a final `entry.id` at a given collection
 * prefix. Runtime counterpart to `canonicalEntryUrl`.
 *
 *   entryRouteUrl("", "1.1.1.1/encryption") → "/1.1.1.1/encryption"
 *   entryRouteUrl("/v1", "guides/index")    → "/v1/guides"
 *   entryRouteUrl("", "index")              → "/"
 */
export function entryRouteUrl(prefix: string, entryId: string): string {
  const key = entryRouteKey(entryId);
  if (key === "") return prefix === "" ? "/" : prefix;
  return `${prefix}/${key}`;
}
