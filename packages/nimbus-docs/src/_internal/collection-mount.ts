/**
 * Collection-mount conventions — one source of truth for "what URL prefix
 * does collection X serve at?".
 *
 * Shared between `index.ts` (which uses it for `getIndexedEntries`,
 * `getDocsPageProps`, etc.) and `lint/site-model.ts` (where
 * `findDuplicateRoutes` needs it to detect cross-collection URL
 * collisions). Keeping the function here prevents the duplicate-slug
 * validator from drifting out of sync with the actual routing.
 */

/** Primary collection name — mounted at the site root with no prefix. */
export const PRIMARY_COLLECTION = "docs";

export interface VersionInfo {
  /** Non-current version slugs (`docs-<slug>` collections mount at `/<slug>`). */
  others: readonly string[];
}

/**
 * Resolve the URL-prefix segment for a given collection name.
 *
 *   1. Primary `docs` collection mounts at root → returns `""`.
 *   2. With `versions` configured, a `docs-<slug>` collection whose slug
 *      appears in `versions.others` mounts under `/<slug>` (the version
 *      label, not the collection id).
 *   3. Any other collection (`api`, `blog`, …) mounts at `/<collection>`.
 *
 * Returned shape: empty string OR `/<segment>` with leading slash, no
 * trailing slash. Callers append `/<entryId>` or `/index.md`.
 */
export function collectionMountPrefix(
  collection: string,
  versions?: VersionInfo | null,
): string {
  if (collection === PRIMARY_COLLECTION) return "";
  if (versions && collection.startsWith("docs-")) {
    const slug = collection.slice("docs-".length);
    if (versions.others.includes(slug)) return `/${slug}`;
  }
  return `/${collection}`;
}

/**
 * Resolve the URL-safe label a collection is referenced by — the segment
 * that appears in URLs and section headers. For version collections this
 * is the manifest's short slug; for everything else it's the collection id.
 */
export function collectionLabel(
  collection: string,
  versions?: VersionInfo | null,
): string {
  if (collection === PRIMARY_COLLECTION) return collection;
  if (versions && collection.startsWith("docs-")) {
    const slug = collection.slice("docs-".length);
    if (versions.others.includes(slug)) return slug;
  }
  return collection;
}
