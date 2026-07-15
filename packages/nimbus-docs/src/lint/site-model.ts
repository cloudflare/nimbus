/**
 * Lint-side data shapes + the `nimbus/duplicate-slug` build validator.
 *
 * Route truth for `nimbus/internal-link` comes from Astro itself
 * (`astro:build:done` hands us the emitted `pages` array — the single
 * source of truth for served URLs). The integration writes that to
 * `.nimbus/routes.json`; the type lives here only so the rule and the
 * writer agree on the shape.
 *
 * The duplicate-slug validator runs *before* the build because Astro
 * silently dedupes colliding routes — by the time `astro:build:done`
 * fires, one entry has already shadowed the other. We catch collisions
 * pre-build by computing each entry's canonical slug with the same
 * library Astro's content layer uses (`github-slugger`), then grouping
 * entries by collection + slug. This is mirror-behavior, but mirroring
 * a documented public library rather than Astro's private internals —
 * a much smaller maintenance surface.
 */

import path from "node:path";

import { canonicalEntryUrl, canonicalSlug } from "../_internal/astro-slug.js";
import { walkFilesSync } from "../_internal/fs-walk.js";
import {
  collectionMountPrefix,
  type VersionInfo,
} from "../_internal/collection-mount.js";

// Re-exported for tests; the helpers themselves live in `_internal/` because
// framework URL builders (sidebar, sitemap, llms.txt) also use them.
export { canonicalSlug };
export type { VersionInfo };

export interface ContentEntry {
  /** Collection name — the first path segment under `src/content`. */
  collection: string;
  /** Entry id — the path under the collection, without the `.mdx` extension. */
  id: string;
  /** Path relative to the content root (`<collection>/<id>.mdx`), for display. */
  relPath: string;
}

/**
 * Walk a content root for `.mdx` files and return one entry per file.
 * Uses the filesystem segment as the `collection` — correct only when each
 * collection's `base` matches its registered key. Use
 * `enumerateEntriesByBase` when the caller has the real `(key, base)` map
 * (so `docsCollection({ base: "documentation" })` doesn't get mis-tagged).
 */
export function enumerateEntries(contentRoot: string): ContentEntry[] {
  const out: ContentEntry[] = [];
  for (const { rel } of walkFilesSync(contentRoot, { extensions: [".mdx"] })) {
    const slash = rel.indexOf("/");
    if (slash === -1) continue; // loose top-level file, not under a collection
    out.push({
      collection: rel.slice(0, slash),
      id: rel.slice(slash + 1).replace(/\.mdx$/, ""),
      relPath: rel,
    });
  }
  return out;
}

/**
 * Walk `src/content/` using a `(collection key → folder name)` map so
 * entries are tagged with the registered key, not the on-disk folder.
 * Skips folders that aren't in the map (they're loose content, not a
 * routed collection).
 */
export function enumerateEntriesByBase(
  contentRoot: string,
  bases: ReadonlyMap<string, string>,
): ContentEntry[] {
  // Invert the map (folder → key). Two collections with the same base
  // would be a content.config.ts authoring error; we silently keep the
  // last one — Astro itself errors on duplicate-key collection registration.
  const folderToKey = new Map<string, string>();
  for (const [key, base] of bases) folderToKey.set(base, key);

  const out: ContentEntry[] = [];
  for (const [folder, key] of folderToKey) {
    const baseDir = path.join(contentRoot, folder);
    for (const { rel } of walkFilesSync(baseDir, { extensions: [".mdx"] })) {
      out.push({
        collection: key,
        id: rel.replace(/\.mdx$/, ""),
        relPath: `${folder}/${rel}`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Duplicate-slug detection — runs pre-build because Astro silently dedupes.
// ---------------------------------------------------------------------------

/**
 * A single thing that owns a URL: either a content entry under
 * `src/content/<collection>/` or a static page file under `src/pages/`.
 * The dup-check only needs the URL and a display path; everything else is
 * caller-side bookkeeping.
 */
export interface RouteOwner {
  /** The mounted URL this source resolves to (canonicalized, no trailing slash). */
  url: string;
  /** Project-relative path, used in error messages. */
  source: string;
  /** Source kind; defaults to `content`. See `findDuplicateRoutes`. */
  kind?: "content" | "page";
}

export interface DuplicateGroup {
  /** The URL multiple sources resolve to. */
  url: string;
  /** All sources that claim that URL (project-relative paths). */
  sources: string[];
  /** Deterministic page-over-content shadow (callers warn); see `findDuplicateRoutes`. */
  shadowedByPage: boolean;
}

/**
 * Group route owners by URL. A group with more than one member is a real
 * collision Astro will silently shadow at build time — that's what this
 * helper exists to surface before the build wastes a cycle.
 *
 * Owners come from two sources, both fed in by the integration:
 *
 *   - **Content entries**, with URLs computed via
 *     `collectionMountPrefix(entry.collection, versions) +
 *     canonicalEntryUrl(prefix, entry.id)`. Catches cross-collection
 *     (`docs/blog/post.mdx` vs `blog/post.mdx`), version-collection
 *     (`docs/v1/x.mdx` vs `docs-v1/x.mdx`), case-only, and
 *     leaf-vs-folder-index collisions Astro's content layer dedupes.
 *   - **Static `src/pages/**` files** (via `enumerateStaticPageRoutes`).
 *     Catches the page-vs-content collision (`pages/search.astro`
 *     shadowing `content/docs/search.mdx` at `/search`).
 *
 * Doesn't honor `data.slug` frontmatter overrides — entries that use those
 * may produce false negatives. Reading frontmatter from every entry
 * pre-build would add noticeable I/O for a v1 feature; tracked as a
 * follow-up.
 */
export function findDuplicateRoutes(
  owners: readonly RouteOwner[],
): DuplicateGroup[] {
  const byUrl = new Map<string, RouteOwner[]>();
  for (const owner of owners) {
    const bucket = byUrl.get(owner.url);
    if (bucket) bucket.push(owner);
    else byUrl.set(owner.url, [owner]);
  }
  const dups: DuplicateGroup[] = [];
  for (const [url, group] of byUrl) {
    if (group.length <= 1) continue;
    const pages = group.filter((o) => o.kind === "page").length;
    const contents = group.length - pages;
    // One explicit page over one content entry: Astro serves the page (static
    // beats the content catch-all), so it's intended shadowing, not an error.
    // 2+ content entries stay mutually ambiguous even with a page present.
    const shadowedByPage = pages === 1 && contents === 1;
    dups.push({ url, sources: group.map((o) => o.source), shadowedByPage });
  }
  return dups;
}

/** Format duplicate groups into a build-error message. */
export function formatDuplicateRoutes(dups: DuplicateGroup[]): string {
  const lines = dups.map((d) => `  ${d.url}  ←  ${d.sources.join(", ")}`);
  const noun = dups.length === 1 ? "route is" : "routes are";
  return (
    `[nimbus-docs] Duplicate ${noun} claimed by more than one source (nimbus/duplicate-slug):\n` +
    lines.join("\n") +
    `\n\nTwo or more sources resolve to the same URL — one would shadow the other on the deployed site ` +
    `(Astro silently dedupes colliding routes). Rename or move one source in each pair.`
  );
}

/** Format page-shadows-content groups into a (non-fatal) warning message. */
export function formatShadowedRoutes(dups: DuplicateGroup[]): string {
  const lines = dups.map((d) => `  ${d.url}  ←  ${d.sources.join(", ")}`);
  const noun = dups.length === 1 ? "route is" : "routes are";
  return (
    `[nimbus-docs] (nimbus/duplicate-slug, warning) ${dups.length} ${noun} served by an explicit src/pages file that shadows a content entry at the same URL:\n` +
    lines.join("\n") +
    `\n\nAstro serves the page and drops the content route (deterministic). Intended when a content page wraps a custom page component; verify each shadow is intentional.`
  );
}

// ---------------------------------------------------------------------------
// Static-page-route enumeration — the second source for findDuplicateRoutes.
// ---------------------------------------------------------------------------

/**
 * Walk `src/pages/**` for static page files and return their served URLs.
 *
 * Considered "static" iff the path has no dynamic segments (`[id]`,
 * `[...slug]`). Dynamic routes are skipped because their emitted URLs come
 * from `getStaticPaths` at build time — we can't know them statically, so
 * we can't detect collisions involving them pre-build. The opaque-namespace
 * pattern from earlier drafts (mark a whole namespace as un-checkable)
 * doesn't apply here: dup-detection only catches *exact* URL collisions,
 * and any catch-all owned by the framework's docs renderer collides with a
 * content entry the *content* enumeration also catches.
 *
 * URL normalization: lowercase each segment + strip a trailing `/index`,
 * matching Astro's `joinSegments` behavior for static routes. Underscore-
 * prefixed files are skipped (Astro's private-helper convention). Endpoint
 * files (`name.<ext>.<ts|js>`) map to `/name.<ext>` per Astro's convention.
 */
export interface StaticPageRoute {
  /** The URL this page file serves at, canonicalized (no trailing slash). */
  url: string;
  /** Project-relative path, e.g. `src/pages/search.astro`. */
  source: string;
}

const PAGE_EXTS = new Set([".astro", ".ts", ".js", ".md", ".mdx"]);

export function enumerateStaticPageRoutes(
  pagesRoot: string,
  projectRoot: string,
): StaticPageRoute[] {
  const out: StaticPageRoute[] = [];
  // `src/pages` skips Astro's `_`-private dirs but not dotfolders, and yields
  // every file — the PAGE_EXTS/basename checks below decide what's a route.
  for (const { rel } of walkFilesSync(pagesRoot, {
    skipUnderscoreDirs: true,
    skipDotDirs: false,
  })) {
    const ext = path.extname(rel);
    if (!PAGE_EXTS.has(ext)) continue;

    const base = path.basename(rel);
    if (base.startsWith("_")) continue; // Astro's private-helper convention

    const parts = rel.split("/");
    // Pre-strip the leaf extension so the dynamic-segment test sees the
    // bare segment (`[id]` not `[id].astro`).
    const bareLeaf = parts[parts.length - 1]!.replace(/\.[^.]+$/, "");
    if (parts.slice(0, -1).some(isDynamicSegment) || isDynamicSegment(bareLeaf)) {
      continue;
    }

    const url = fileToRoute(parts, ext);
    const sourceAbs = path.join(pagesRoot, rel);
    const source = path.relative(projectRoot, sourceAbs).replace(/\\/g, "/");
    out.push({ url, source });
  }
  return out;
}

function isDynamicSegment(seg: string): boolean {
  return seg.startsWith("[") && seg.endsWith("]") && seg.length >= 3;
}

/**
 * Translate a static page file path (no dynamic segments) to its URL.
 *
 *   pages/index.astro       → /
 *   pages/search.astro      → /search
 *   pages/Search.astro      → /search       (Astro lowercases via joinSegments)
 *   pages/llms.txt.ts       → /llms.txt     (endpoint: strip .ts, keep .txt)
 *   pages/blog/index.astro  → /blog
 *   pages/blog/post.md      → /blog/post
 */
function fileToRoute(parts: string[], ext: string): string {
  const cloned = [...parts];
  const last = cloned[cloned.length - 1]!;

  if ((ext === ".ts" || ext === ".js") && /\.[^.]+\.[tj]s$/.test(last)) {
    // Endpoint: `name.<inner>.<ts|js>` → strip just the trailing `.ts`/`.js`.
    cloned[cloned.length - 1] = last.replace(/\.[tj]s$/, "");
  } else {
    cloned[cloned.length - 1] = last.replace(/\.[^.]+$/, "");
  }

  // Strip trailing `index` segment so `foo/index.astro` → `/foo`.
  if (cloned[cloned.length - 1] === "index") cloned.pop();

  // Lowercase each segment to match Astro's `joinSegments` behavior.
  const joined = cloned.map((s) => s.toLowerCase()).join("/");
  return joined === "" ? "/" : `/${joined}`;
}

/**
 * Compute the mounted URL a content entry resolves to. Exposed so callers
 * (the integration's pre-build dup-check) can build `RouteOwner` records
 * with the same logic the framework uses everywhere else.
 */
export function contentEntryUrl(
  entry: ContentEntry,
  versions?: VersionInfo | null,
): string {
  const prefix = collectionMountPrefix(entry.collection, versions);
  return canonicalEntryUrl(prefix, entry.id);
}

// ---------------------------------------------------------------------------
// Route truth — shape only. The integration's `astro:build:done` hook
// constructs and writes this; `internal-link.ts` reads it.
// ---------------------------------------------------------------------------

export interface RouteTruth {
  /** Schema version. Bump if the shape changes. */
  version: 1;
  /** Astro `base` config (`"/docs"`, `""`). Empty string when unset. */
  base: string;
  /**
   * Every URL Astro emitted during the last build, canonicalized to
   * `/foo` form (no trailing slash unless root). The lint rule resolves
   * internal links against this set.
   */
  knownRoutes: string[];
  /**
   * Reserved for future SSR-route handling — URL prefixes that can't be
   * statically enumerated. Empty in the current all-prerendered path.
   */
  opaqueNamespaces: string[];
}
