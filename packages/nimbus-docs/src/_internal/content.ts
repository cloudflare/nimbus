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

import { createHash } from "node:crypto";

import type { CollectionEntry } from "astro:content";

/** Primary collection name. Hard-coded — see also `getDocsStaticPaths`. */
const PRIMARY_COLLECTION = "docs";

/**
 * Content-derived `cacheKey` for Astro's experimental incremental static
 * builds (`experimental.incrementalBuild`). Returned from `getStaticPaths`,
 * it lets Astro skip re-rendering a page when neither the key nor the page's
 * module dependency graph changed since the last build.
 *
 * The key hashes only the entry's *own* content — id, raw body, and
 * frontmatter `data`. Component/layout changes are covered separately by
 * Astro's dependency-graph hash, so they intentionally don't feed in here.
 *
 * We hash body+data rather than reading a loader-provided `entry.digest`
 * because `digest` isn't part of the public `CollectionEntry` type (it
 * depends on the loader), whereas body+data is always present and keeps the
 * framework's `tsc` build clean.
 */
export function entryCacheKey(entry: CollectionEntry<string>): string {
  const hash = createHash("sha256");
  hash.update(entry.collection);
  hash.update("\0");
  hash.update(entry.id);
  hash.update("\0");
  hash.update(entry.body ?? "");
  hash.update("\0");
  hash.update(stableStringify(entry.data ?? {}));
  return hash.digest("hex");
}

/**
 * Deterministic JSON serialization with sorted object keys, so a `cacheKey`
 * doesn't churn when a loader emits frontmatter fields in a different order
 * between builds.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.keys(val as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = (val as Record<string, unknown>)[key];
          return acc;
        }, {});
    }
    return val;
  });
}

/**
 * Return visible entries from one or more collections. Drafts are
 * filtered out in production builds (matching the existing
 * single-collection behaviour).
 *
 * Defaults to `["docs"]` — the framework's primary collection.
 * Cross-collection callers (llms.txt aggregators, custom indexes,
 * etc.) pass an explicit list.
 *
 * Returns a flat `CollectionEntry<string>[]` so cross-collection
 * traversal doesn't need to know the user's collection names at type
 * time. Callers that need per-collection type safety should call
 * `getCollection("api")` directly.
 */
export async function getVisibleEntries(
  collections: string[] = [PRIMARY_COLLECTION],
): Promise<CollectionEntry<string>[]> {
  const lists = await Promise.all(collections.map(loadVisibleEntries));
  return lists.flat();
}

/**
 * Return visible entries grouped by collection. Used by the sidebar
 * builder so `collection:` autogenerate can look up entries by name
 * without re-fetching.
 */
// Per-collection cache of visible entries, reused across pages. Cached in dev
// too (the nav build is too expensive to repeat per request); the dev server
// clears it on content change via `clearContentCaches`. Draft filtering stays
// PROD-only so dev still shows drafts.
const visibleEntriesByName = new Map<string, CollectionEntry<string>[]>();

/** Drop the visible-entry cache (dev content-change invalidation). */
export function clearContentCaches(): void {
  visibleEntriesByName.clear();
}

async function loadVisibleEntries(
  name: string,
): Promise<CollectionEntry<string>[]> {
  const cached = visibleEntriesByName.get(name);
  if (cached) return cached;
  const { getCollection } = await import("astro:content");
  const all = await getCollection(name).catch(
    () => [] as CollectionEntry<string>[],
  );
  const visible = import.meta.env.PROD
    ? all.filter((entry: CollectionEntry<string>) => !entry.data.draft)
    : all;
  visibleEntriesByName.set(name, visible);
  return visible;
}

export async function getVisibleEntriesByCollection(
  collections: string[],
): Promise<Record<string, CollectionEntry<string>[]>> {
  const out: Record<string, CollectionEntry<string>[]> = {};
  await Promise.all(
    collections.map(async (name) => {
      out[name] = await loadVisibleEntries(name);
    }),
  );
  return out;
}
