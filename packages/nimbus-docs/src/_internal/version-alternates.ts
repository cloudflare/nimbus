/**
 * Cross-version alternates table.
 *
 * Builds the SEO-equivalence-class map at build time: which pages across
 * version collections refer to the same logical content. Consumers
 * (`getVersionAlternates`, `getCanonicalUrl`, the auto-redirect step)
 * read from the resolved structure rather than re-walking collections.
 *
 * Two ways pages get linked into the same class:
 *   1. Same `entry.id` across collections — `docs/foo.mdx` and
 *      `docs-v1/foo.mdx` are obviously the same page.
 *   2. `previousSlug` frontmatter on the newer page declares its slug in
 *      an older version — `docs/foo-renamed.mdx` with
 *      `previousSlug: "foo-old"` connects to `docs-v1/foo-old.mdx`.
 *
 * Multiple equivalences chain — if v3.A renames to v2.B and v2.B
 * renames to v1.C, they're all the same logical page. Union-find
 * collapses the chains in one pass.
 *
 * The output is queried per-page from page routes (to inject
 * `<link rel="alternate">` and `<link rel="canonical">` into `<head>`)
 * and once per build to emit Astro redirects.
 */

import type { ResolvedVersions } from "../types.js";
import { entryRouteUrl } from "./astro-slug.js";
import { PRIMARY_COLLECTION } from "./collection-mount.js";
import { toBrowserHref } from "./url.js";

/**
 * Minimum-viable entry shape the table needs. Matches what
 * `astro:content`'s `getCollection()` returns, but expressed structurally
 * so the integration can construct the same data without importing the
 * virtual `astro:content` module (which isn't available at integration
 * setup time).
 */
export interface VersionEntryInput {
  /** Astro collection ID (e.g. `"docs"`, `"docs-v1"`). */
  collection: string;
  /** Astro entry id (the slug — `"foo"`, `"guides/setup"`, …). */
  id: string;
  /** Frontmatter `previousSlug` (string, array of strings, or absent). */
  previousSlug?: string | string[];
}

/** A single page reference within the alternates graph. */
export interface VersionPageRef {
  /** Astro collection ID. */
  collection: string;
  /** Version slug — `current` for `docs`, or `v1`/`v2`/… for `docs-v*`. */
  version: string;
  /** Page slug (entry.id). */
  slug: string;
  /**
   * Resolved URL path, browser-href form: leading slash and a trailing
   * slash on HTML document routes. Rendered straight into
   * `<link rel="alternate">` / `<link rel="canonical">`.
   */
  url: string;
}

export interface VersionAlternateRecord {
  /** The page this record describes. */
  self: VersionPageRef;
  /** All other pages in the same logical-page class, in version order. */
  alternates: VersionPageRef[];
  /**
   * The current-version page in this logical-page class, if one exists
   * and is not `self`. Drives `<link rel="canonical">`. `null` when:
   *   - `self` is already the current-version page, or
   *   - no page in the current version exists for this logical page.
   */
  canonical: VersionPageRef | null;
}

/**
 * Resolved alternates table, indexed for O(1) lookup per page.
 *
 * The key is `${collection}:${entryId}`. Consumers compute that key from
 * the entry they're rendering and read out the alternates + canonical.
 */
export type VersionAlternatesTable = Record<string, VersionAlternateRecord>;

/**
 * Build the alternates table for one site.
 *
 * Pass:
 *   - `versions`: resolved manifest (or null when the site is unversioned).
 *   - `entries`: every visible entry from every docs-shaped version
 *     collection. Drafts already filtered.
 *
 * Returns an empty table when `versions` is null or only one version is
 * configured (no cross-linking work to do).
 */
export function buildVersionAlternates(
  versions: ResolvedVersions | null,
  entries: VersionEntryInput[],
): VersionAlternatesTable {
  if (!versions || versions.all.length < 2) return {};

  // 1. Filter to entries we actually care about (in a version collection)
  //    and compute each one's PageRef.
  const refs: VersionPageRef[] = [];
  for (const entry of entries) {
    const version = collectionToVersion(versions, entry.collection);
    if (version === null) continue;
    refs.push({
      collection: entry.collection,
      version,
      slug: entry.id,
      url: pageUrl(versions, version, entry.id),
    });
  }

  // 2. Union-find over the ref set. Two refs are unioned if either
  //    they share a slug across versions OR one's previousSlug names
  //    the other's slug in the same version chain.
  const indexByKey = new Map<string, number>();
  refs.forEach((ref, i) => indexByKey.set(refKey(ref), i));

  const parent = refs.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root]! !== root) root = parent[root]!;
    let cursor = i;
    while (parent[cursor]! !== cursor) {
      const next = parent[cursor]!;
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // 2a. Group by slug across versions.
  const bySlug = new Map<string, number[]>();
  for (let i = 0; i < refs.length; i++) {
    const slug = refs[i]!.slug;
    const bucket = bySlug.get(slug);
    if (bucket) bucket.push(i);
    else bySlug.set(slug, [i]);
  }
  for (const ids of bySlug.values()) {
    for (let i = 1; i < ids.length; i++) union(ids[0]!, ids[i]!);
  }

  // 2b. Walk previousSlug edges. Each entry's previousSlug names a slug
  //     that existed in an older version. We search ALL older versions
  //     for that slug and union — multiple matches are fine (a slug
  //     that persisted through v1 → v2 → v3 with the same name).
  //
  //     `versions.all = [current, ...others]` is the ordering. For an
  //     entry in version V at index `i`, "older" means versions at
  //     indices > `i`.
  const orderIndex = new Map<string, number>();
  versions.all.forEach((v, i) => orderIndex.set(v, i));

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!entry.previousSlug) continue;
    const ref = refs[refs.findIndex((r) => r.collection === entry.collection && r.slug === entry.id)];
    if (!ref) continue;
    const selfOrder = orderIndex.get(ref.version);
    if (selfOrder === undefined) continue;
    const previousSlugs = Array.isArray(entry.previousSlug)
      ? entry.previousSlug
      : [entry.previousSlug];

    for (const prevSlug of previousSlugs) {
      // Find every ref with slug == prevSlug in an older version
      for (let j = 0; j < refs.length; j++) {
        const other = refs[j]!;
        if (other.slug !== prevSlug) continue;
        const otherOrder = orderIndex.get(other.version);
        if (otherOrder === undefined) continue;
        if (otherOrder <= selfOrder) continue; // not older
        const selfIdx = refs.indexOf(ref);
        if (selfIdx >= 0) union(selfIdx, j);
      }
    }
  }

  // 3. Group refs by their root (each root = one logical page).
  const groups = new Map<number, number[]>();
  for (let i = 0; i < refs.length; i++) {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(i);
    else groups.set(root, [i]);
  }

  // 4. Emit one record per ref.
  const table: VersionAlternatesTable = {};
  for (const memberIndices of groups.values()) {
    // Sort within group by manifest version order so output is deterministic.
    memberIndices.sort((a, b) => {
      const ai = orderIndex.get(refs[a]!.version) ?? Number.MAX_SAFE_INTEGER;
      const bi = orderIndex.get(refs[b]!.version) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });
    const members = memberIndices.map((i) => refs[i]!);
    const currentRef = members.find((m) => m.version === versions.current) ?? null;

    // Hidden-version filtering. Hidden versions are off the radar from
    // every agent/SEO surface — so non-hidden pages must not advertise
    // an `<link rel="alternate">` pointing at a hidden sibling. Hidden
    // pages themselves can still have a canonical pointing at current
    // (SEO authority consolidation on direct visits is desirable), but
    // their own alternates list is suppressed at the head emission
    // layer in NimbusHead.
    const hiddenVersions = new Set(versions.hidden);

    for (const self of members) {
      // Exclude hidden-version siblings from this page's alternates.
      // The page itself may be hidden (and NimbusHead will suppress the
      // emission anyway), but we keep the data consistent.
      const alternates = members.filter(
        (m) => m !== self && !hiddenVersions.has(m.version),
      );
      const canonical =
        currentRef && currentRef !== self ? currentRef : null;
      table[refKey(self)] = { self, alternates, canonical };
    }
  }

  return table;
}

/**
 * Compute the slugs that exist in `current` but are absent in a given
 * older version — the set that should auto-redirect from `/v/<slug>` to
 * `/<slug>` when a reader follows a stale link. Includes slugs reached
 * via `previousSlug` (so a renamed page's old slug in the old version
 * also redirects correctly when the user types the original new URL by
 * accident under the old prefix).
 *
 * Returns a list of `{ from, to }` redirect pairs ready for Astro's
 * `redirects` config. `from` is the URL the reader hit; `to` is the
 * current-version sibling. Both are absolute paths in the trailing-slash
 * browser-href form Astro serves under `build.format: "directory"`.
 * Astro's default `trailingSlash: "ignore"` matches incoming requests in
 * either form, so a reader landing on `/v1/foo` still resolves.
 */
export function computeMissingPageRedirects(
  versions: ResolvedVersions | null,
  table: VersionAlternatesTable,
  entries: VersionEntryInput[],
): { from: string; to: string }[] {
  if (!versions || versions.all.length < 2) return [];

  // Build a set of (version, slug) pairs that actually exist as files.
  const existing = new Set<string>();
  for (const entry of entries) {
    const version = collectionToVersion(versions, entry.collection);
    if (version === null) continue;
    existing.add(`${version}:${entry.id}`);
  }

  const redirects: { from: string; to: string }[] = [];

  // For each current-version page, check each older version. If the old
  // version doesn't have a file with the same slug AND doesn't have one
  // linked via the alternates table → emit a redirect from the would-be
  // old URL to the current URL.
  for (const entry of entries) {
    const version = collectionToVersion(versions, entry.collection);
    if (version !== versions.current) continue;
    const currentUrl = pageUrl(versions, version, entry.id);

    for (const oldVersion of versions.others) {
      if (existing.has(`${oldVersion}:${entry.id}`)) continue;
      // Also skip when the alternates table already provides a
      // direct sibling in that old version (rename case).
      // `refKey` only consumes `collection` and `slug`; drop the extras.
      const record = table[refKey({ collection: entry.collection, slug: entry.id })];
      const altInOldVersion = record?.alternates.some((a) => a.version === oldVersion);
      if (altInOldVersion) continue;

      redirects.push({
        from: pageUrl(versions, oldVersion, entry.id),
        to: currentUrl,
      });
    }
  }

  return redirects;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function refKey(ref: { collection: string; slug: string }): string {
  return `${ref.collection}:${ref.slug}`;
}

/**
 * Resolve the version slug for a given Astro collection ID, or null if
 * the collection is not part of the versioning manifest.
 */
function collectionToVersion(
  versions: ResolvedVersions,
  collection: string,
): string | null {
  if (collection === PRIMARY_COLLECTION) return versions.current;
  if (!collection.startsWith("docs-")) return null;
  const slug = collection.slice("docs-".length);
  return versions.all.includes(slug) ? slug : null;
}

/**
 * Build the URL for a `(version, slug)` pair. Matches the convention in
 * `index.ts::resolveCollectionPrefix`:
 *   - current version → root (`/foo`)
 *   - others → `/<version>/<slug>`
 *
 * `slug` is a final `entry.id` (see callers), so it uses `entryRouteUrl`
 * (no re-slug — see `_internal/astro-slug.ts`). The `<link rel="alternate">`
 * tags and auto-redirect machinery both consume these URLs.
 */
function pageUrl(versions: ResolvedVersions, version: string, slug: string): string {
  const prefix = version === versions.current ? "" : `/${version}`;
  return toBrowserHref(entryRouteUrl(prefix, slug));
}
