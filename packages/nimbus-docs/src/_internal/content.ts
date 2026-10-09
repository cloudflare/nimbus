/**
 * Content collection access for helpers.
 *
 * Dynamic import of `astro:content` for the same reason as
 * runtime-config: Astro's config loader runs in plain Node, where
 * `astro:content` doesn't exist. We defer to call time, which only
 * happens at page render.
 *
 * There is intentionally no global "list of collections Nimbus knows
 * about" — the framework doesn't try to mirror what
 * `content.config.ts` registers. Callers that need entries from
 * multiple collections pass them explicitly; the sidebar builder
 * derives its list from `sidebar.items` references.
 */

import type { CollectionEntry, CollectionKey } from "astro:content";

import {
  audienceCacheKey,
  resolveAudience,
  type ProjectionContext,
} from "./projection.js";

/** Primary collection name. Hard-coded — see also `getDocsStaticPaths`. */
const PRIMARY_COLLECTION = "docs";

/**
 * Return visible entries from one or more collections. Drafts are
 * filtered out in production builds (matching the existing
 * single-collection behaviour).
 *
 * Defaults to `["docs"]` — the framework's primary collection.
 * Cross-collection callers (llms.txt aggregators, custom indexes,
 * etc.) pass an explicit list.
 *
 * Literal collection names preserve their entry types. Runtime-derived
 * names return the union of the project's registered collection entries.
 */
export function getVisibleEntries(
  collections?: undefined,
  ctx?: ProjectionContext,
): Promise<CollectionEntry<"docs">[]>;
export function getVisibleEntries<C extends CollectionKey>(
  collections: readonly C[],
  ctx?: ProjectionContext,
): Promise<CollectionEntry<C>[]>;
export function getVisibleEntries(
  collections: readonly string[],
  ctx?: ProjectionContext,
): Promise<CollectionEntry<CollectionKey>[]>;
export async function getVisibleEntries(
  collections: readonly string[] = [PRIMARY_COLLECTION],
  ctx?: ProjectionContext,
): Promise<CollectionEntry<CollectionKey>[]> {
  const lists = await Promise.all(
    collections.map((name) => loadVisibleEntries(name as CollectionKey, ctx)),
  );
  return lists.flat();
}

export function getVisibleEntry<C extends CollectionKey>(
  collection: C,
  id: string,
  ctx?: ProjectionContext,
): Promise<CollectionEntry<C> | null>;
export function getVisibleEntry(
  collection: string,
  id: string,
  ctx?: ProjectionContext,
): Promise<CollectionEntry<CollectionKey> | null>;
export async function getVisibleEntry(
  collection: string,
  id: string,
  ctx?: ProjectionContext,
): Promise<CollectionEntry<CollectionKey> | null> {
  const { hasApiPageAssets, getApiAssetEntry } =
    await import("./api/page-assets-runtime.js");
  if (await hasApiPageAssets(collection))
    return getApiAssetEntry(collection, id);
  const entries = await loadVisibleEntries(collection as CollectionKey, ctx);
  return entries.find((entry) => entry.id === id) ?? null;
}

/**
 * Return visible entries grouped by collection. Used by the sidebar
 * builder so `collection:` autogenerate can look up entries by name
 * without re-fetching.
 */
// Per-collection cache, reused across pages (dev too); cleared on content
// change. Draft filtering stays PROD-only. Keyed `<collection>::<audienceKey>`
// so a per-audience projection can't poison another audience's cache.
const visibleEntriesByName = new Map<string, unknown[]>();

/** Drop the visible-entry cache (dev content-change invalidation). */
export function clearContentCaches(): void {
  visibleEntriesByName.clear();
}

async function loadVisibleEntries<C extends CollectionKey>(
  name: C,
  ctx?: ProjectionContext,
): Promise<CollectionEntry<C>[]> {
  const { hasApiPageAssets, getApiAssetEntries } =
    await import("./api/page-assets-runtime.js");
  if (await hasApiPageAssets(name))
    return (await getApiAssetEntries(name)) as CollectionEntry<C>[];
  const cacheKey = `${name}::${audienceCacheKey(resolveAudience(ctx))}`;
  const cached = visibleEntriesByName.get(cacheKey) as CollectionEntry<C>[] | undefined;
  if (cached) return cached;
  const { getCollection } = await import("astro:content");
  const all = await getCollection(name).catch(
    () => [] as CollectionEntry<C>[],
  );
  const published = import.meta.env.PROD ? all.filter((entry) => !entry.data.draft) : all;
  visibleEntriesByName.set(cacheKey, published);
  return published;
}

export async function getVisibleEntriesByCollection(
  collections: string[],
  ctx?: ProjectionContext,
): Promise<Record<string, CollectionEntry<string>[]>> {
  const out: Record<string, CollectionEntry<string>[]> = {};
  await Promise.all(
    collections.map(async (name) => {
      out[name] = await loadVisibleEntries(name, ctx);
    }),
  );
  return out;
}
