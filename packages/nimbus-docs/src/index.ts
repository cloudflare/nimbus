/**
 * Main entry for `nimbus-docs`.
 *
 * Exports the Astro integration (default), config helper, the data helpers
 * (sidebar, prev/next, breadcrumbs, TOC), and the page composition helpers
 * (`getDocsStaticPaths`, `getDocsPageProps`).
 *
 * Helpers read the user's config from `virtual:nimbus/config` (provided
 * by our Vite plugin) and content entries from `astro:content`. Both
 * are external in tsdown and resolved at the consumer's build time.
 */

import {
  loadIndexedCollections,
  loadNimbusConfig,
  loadVersionAlternates,
} from "./_internal/runtime-config.js";
import { loadCollectionOrWarn } from "./_internal/load-collection.js";
import { runtimeWarn } from "./_internal/runtime-warn.js";
import {
  getVisibleEntries,
  getVisibleEntriesByCollection,
  clearContentCaches,
  entryCacheKey,
} from "./_internal/content.js";
import {
  applyOverviewLeaf,
  buildSidebarTree,
  collectSidebarCollectionRefs,
  cloneSidebarTree,
  deriveSidebarSections,
  deriveTransformCtx,
  findActivePath,
  isolateToBoundary,
  markActiveState,
  scopeToCurrentSection,
  sidebarHash,
} from "./_internal/sidebar.js";
import { entryRouteUrl } from "./_internal/astro-slug.js";
import { toBrowserHref } from "./_internal/url.js";
import {
  PRIMARY_COLLECTION,
  collectionLabel as resolveCollectionSlug,
  collectionMountPrefix as resolveCollectionPrefix,
} from "./_internal/collection-mount.js";
import { renderEntryAsMarkdown } from "./_internal/transform.js";
import { buildCorpusMarkdown } from "./_internal/corpus.js";
import {
  assembleBreadcrumbs,
  breadcrumbsFromUrl,
  composeRouteBreadcrumbs,
  getPrevNext as buildPrevNext,
  type BreadcrumbOptions,
} from "./_internal/navigation.js";
import { getHeadings } from "./_internal/toc.js";
import {
  mergePartialHeadings,
  type PartialHeadingOptions,
} from "./_internal/partial-headings.js";
import { getLastUpdatedFromGit } from "./_internal/git-last-updated.js";
import {
  clearValidInternalLinksCache,
  getValidInternalLinks,
} from "./_internal/valid-internal-links.js";

import type {
  Breadcrumb,
  NimbusConfig,
  PrevNext,
  PrevNextOverrides,
  ResolvedVersions,
  SidebarItem,
  SidebarSection,
  SidebarTransform,
  TOCItem,
  VersionAlternateRecord,
  VersionPageRef,
  VersionStatus,
} from "./types.js";

export { nimbus as default } from "./integration.js";
export type { NimbusIntegrationOptions } from "./integration.js";

export type {
  BadgeVariant,
  Breadcrumb,
  NimbusConfig,
  PrevNext,
  PrevNextLink,
  PrevNextOverrides,
  ResolvedVersions,
  SearchProvider,
  SearchResult,
  SidebarBadge,
  SidebarConfig,
  SidebarConfigItem,
  SidebarExternalLinkItem,
  SidebarGroupItem,
  SidebarItem,
  SidebarLinkItem,
  SidebarSection,
  SidebarTransform,
  TOCItem,
  VersionAlternateRecord,
  VersionAlternatesTable,
  VersionPageRef,
  VersionStatus,
  VersionsConfig,
} from "./types.js";

export type { PartialHeadingOptions } from "./_internal/partial-headings.js";
export type { Heading } from "./_internal/partial-headings.js";

/**
 * Collect headings from rendered HTML (see {@link getHeadingsFromHtml}).
 *
 * Use when a page's `Content` is rendered to a string so that runtime
 * headings (e.g. those injected via `set:html`) reach the TOC. Feed the
 * result to {@link getTOC}.
 */
export { getHeadingsFromHtml } from "./_internal/rendered-headings.js";

/**
 * Define a typed Nimbus config. Returns the config unchanged but inferred.
 */
export function defineConfig<T extends NimbusConfig>(config: T): T {
  return config;
}

/** Deterministic short hash of the sidebar structure (for sessionStorage invalidation). */
export { sidebarHash };

/** Render an Astro content entry's raw MDX body as clean markdown. */
export { renderEntryAsMarkdown };

/**
 * The canonical Shiki transformer chain — diff / highlight / focus /
 * error-level / word notations, meta highlight, plus the title-frame +
 * language-badge transformer. Pre-wired into the markdown pipeline for
 * fenced MDX blocks; re-export it so `Code.astro` can pass the same
 * list to Astro's built-in `<Code>` component (which accepts
 * `transformers` as a prop but doesn't auto-read `shikiConfig`).
 */
export { defaultCodeTransformers } from "./_internal/code-transformers.js";

/**
 * Return visible entries across the user's configured `collections`.
 * Drafts are filtered in production builds. Pass an explicit
 * `collections` argument to scope the query to a subset.
 *
 * Returns `CollectionEntry<string>[]` so cross-collection traversal
 * doesn't need per-name type narrowing.
 */
export { getVisibleEntries };

// ---------------------------------------------------------------------------
// Agent-facing indexing
// ---------------------------------------------------------------------------

export interface IndexedEntry {
  /**
   * The Astro CollectionEntry, widened to the union of every registered
   * collection (`CollectionKey`). Using the bare `string` argument here
   * resolves to `never` in a consumer's project — Astro's real
   * `CollectionEntry<C extends CollectionKey>` has no string index
   * signature, so `CollectionEntry<string>` collapses and `.id`/`.data`
   * vanish. `CollectionKey` keeps the field usable across collections.
   */
  entry: import("astro:content").CollectionEntry<import("astro:content").CollectionKey>;
  /** Collection this entry belongs to (e.g. `"docs"`, `"blog"`). */
  collection: string;
  /** Display title — schema field if present, otherwise the entry id. */
  title: string;
  /** Description — undefined when the schema doesn't expose one or it's empty. */
  description: string | undefined;
  /**
   * Site-relative page URL (no origin), with a trailing slash on HTML
   * document routes. The primary docs collection mounts at root; every
   * other collection mounts under its name (`/blog/my-first-post/`). For
   * `.md` alternates use `markdownUrl`, not this field — the root-index
   * case (`/`) needs a different shape.
   */
  url: string;
  /**
   * Site-relative URL of the page's clean-markdown alternate, e.g.
   * `/getting-started/index.md` (or `/index.md` for the root entry).
   * Consumers should use this directly rather than synthesizing from `url`.
   */
  markdownUrl: string;
  /**
   * Site-relative URL of the page's raw-source alternate, e.g.
   * `/getting-started/index.mdx`. Twin grammar: `index.md` is the
   * downleveled render for reading, `index.mdx` is the authored source.
   * `undefined` when the entry has no string body to serve (data-loader
   * collections) — such entries get no `.mdx` route.
   */
  sourceUrl: string | undefined;
  /**
   * Version label this entry belongs to, resolved through the site's
   * `versions` manifest: `versions.current` for the primary `docs`
   * collection, `<v>` for a registered `docs-<v>` collection. `undefined`
   * when the site is unversioned or the collection is not a docs version
   * (`blog`, `api`, …) — surfaces must emit nothing in that case, so
   * unversioned sites stay byte-identical.
   */
  version: string | undefined;
}

export interface IndexedTopLevelGroup {
  /** Top-level slug — first URL segment under root. */
  slug: string;
  /** Display label (today: identical to `slug`; reserved for future sidebar-label integration). */
  label: string;
  /** Entries inside this group, sorted alphabetically by url. */
  members: IndexedEntry[];
  /**
   * What kind of group this is:
   *   - `"primary"` — a folder inside the primary `docs` collection.
   *   - `"secondary"` — a separate non-version collection (`blog`, `api`, …).
   *   - `"version"` — an older docs version (`docs-v1`, …). The root
   *     `/llms.txt` typically filters these out; per-section files
   *     include them so `/v1/llms.txt` still ships.
   */
  kind: "primary" | "secondary" | "version";
  /**
   * True for a version collection listed in `versions.hidden`. Hidden
   * versions stay URL-reachable but are kept off indexing surfaces
   * (root and per-section `llms.txt`); per-section routes should skip
   * groups where `hidden === true`.
   */
  hidden: boolean;
}

export interface IndexedTopLevel {
  /**
   * Single-entry top-level items — the root `/llms.txt` links directly
   * to each leaf's `.md` alternate. Sorted alphabetically by `url`.
   */
  leaves: IndexedEntry[];
  /**
   * Multi-entry top-level items — each becomes a section file at
   * `/<slug>/llms.txt`. Sorted alphabetically by `slug`.
   */
  groups: IndexedTopLevelGroup[];
}

/**
 * Cross-collection entry list for the agent-facing routes
 * (`llms.txt`, per-page `.md` alternates, future `llms-full.txt` and
 * `rag.jsonl`). Implements the indexing baseline of the two-layer
 * architecture documented at `/features/llms-txt`:
 *
 *   - **Multi-collection by default, zero opt-in.** Iterates every
 *     collection registered in `src/content.config.ts` except names
 *     matching `partials` or starting with `_` (reserved).
 *   - **Schema-tolerant.** Reads `title` and `description` if present;
 *     falls back to the entry id for the title and omits the
 *     description otherwise.
 *   - **Per-page filters baked in.** Drops entries with `draft: true`;
 *     absent fields read as the docs-schema default (`draft: false`).
 *     All published pages are indexed — there is no per-page opt-out.
 *     A page that genuinely shouldn't be agent-readable should be kept
 *     out of the content collection entirely.
 *
 * The returned shape is identical regardless of which factory created
 * the collection: hand-rolled `defineCollection({ loader, schema })`
 * collections work without modification.
 */
// Cached across pages (dev too); the dev server clears it on content change
// via `clearNavCaches`.
let indexedEntriesCache: IndexedEntry[] | undefined;

export async function getIndexedEntries(): Promise<IndexedEntry[]> {
  if (indexedEntriesCache) return indexedEntriesCache;
  const { getCollection } = await import("astro:content");
  const collectionNames = await loadIndexedCollections();
  // Fall back to the primary collection name if the build-time parse
  // came up empty. Belt-and-braces: the integration also defaults to
  // ["docs"] when content.config.ts is missing.
  const names = collectionNames.length > 0 ? collectionNames : [PRIMARY_COLLECTION];
  const versions = await getVersions();

  const indexed: IndexedEntry[] = [];
  for (const name of names) {
    // Surfaces a failed registered collection instead of silently dropping it.
    const { entries, warning } = await loadCollectionOrWarn<
      import("astro:content").CollectionEntry<string>
    >(name, (n) => getCollection(n as any));
    if (warning) runtimeWarn(warning);
    const prefix = resolveCollectionPrefix(name, versions);
    const collectionVersion = await getCurrentVersion(name);
    for (const entry of entries) {
      const data = (entry.data ?? {}) as Record<string, unknown>;
      if (data.draft === true) continue;

      const title =
        typeof data.title === "string" && data.title.length > 0
          ? data.title
          : entry.id;
      const rawDescription = data.description;
      const description =
        typeof rawDescription === "string" && rawDescription.length > 0
          ? rawDescription
          : undefined;

      // `entry.id` is the final store id, which `getDocsStaticPaths` routes
      // on verbatim, so use `entryRouteUrl` (no re-slug — see astro-slug.ts).
      // `toBrowserHref` adds the trailing slash so `url` consumers can emit
      // the value straight into `<a href>` without a redirect.
      const canonicalUrl = entryRouteUrl(prefix, entry.id);
      // The `.md` alternate lives at `<page>/index.md`. For the root index
      // of a collection (canonical URL is the bare prefix or `/`), append
      // directly rather than re-derive from the trailing-slash form — the
      // strip-trailing-slash recipe collapses `/` to `""` and produces the
      // wrong path.
      const markdownUrl =
        canonicalUrl === "/" ? "/index.md" : `${canonicalUrl}/index.md`;
      // The raw-source twin exists only for entries with a string body —
      // data-loader collections without one get no `.mdx` alternate.
      const sourceUrl =
        typeof entry.body === "string" && entry.body.length > 0
          ? canonicalUrl === "/"
            ? "/index.mdx"
            : `${canonicalUrl}/index.mdx`
          : undefined;
      indexed.push({
        entry,
        collection: name,
        title,
        description,
        url: toBrowserHref(canonicalUrl),
        markdownUrl,
        sourceUrl,
        version: collectionVersion ?? undefined,
      });
    }
  }
  indexedEntriesCache = indexed;
  return indexed;
}

/**
 * Partition the indexed entries into the shape the root `/llms.txt`
 * and `/[section]/llms.txt` routes need.
 *
 * Convention:
 *   - Primary `"docs"` entries follow the leaf/group rule based on
 *     their `entry.id` top segment (matches single-collection behavior).
 *   - Every other collection becomes a single top-level group named
 *     after the collection, regardless of how many entries it has.
 *     This matches the URL convention (`/api/...`, `/blog/...`).
 */
export async function getIndexedTopLevel(): Promise<IndexedTopLevel> {
  const items = await getIndexedEntries();
  const versions = await getVersions();

  // Build two buckets keyed by their URL-facing slug:
  //   - primary: top-level slug under the `docs` collection
  //   - secondary: every other collection (versions tagged separately
  //     below so consumers can filter the root listing)
  const primaryBuckets = new Map<string, IndexedEntry[]>();
  const secondaryBuckets = new Map<string, IndexedEntry[]>();
  const versionSlugs = new Set<string>(versions?.others ?? []);
  const hiddenSlugs = new Set<string>(versions?.hidden ?? []);

  for (const item of items) {
    if (item.collection === PRIMARY_COLLECTION) {
      const top = item.entry.id.split("/")[0]!;
      const bucket = primaryBuckets.get(top);
      if (bucket) bucket.push(item);
      else primaryBuckets.set(top, [item]);
    } else {
      // Bucket secondary collections by their URL-facing slug (version
      // slug for `docs-<v>` collections, raw collection ID otherwise) so
      // the emitted group label and URL prefix match the route shape.
      const slug = resolveCollectionSlug(item.collection, versions);
      const bucket = secondaryBuckets.get(slug);
      if (bucket) bucket.push(item);
      else secondaryBuckets.set(slug, [item]);
    }
  }

  const leaves: IndexedEntry[] = [];
  const groups: IndexedTopLevelGroup[] = [];

  for (const [slug, members] of primaryBuckets) {
    const isLeaf = members.length === 1 && members[0]!.entry.id === slug;
    if (isLeaf) {
      leaves.push(members[0]!);
    } else {
      groups.push({ slug, label: slug, members, kind: "primary", hidden: false });
    }
  }
  for (const [slug, members] of secondaryBuckets) {
    const kind: "version" | "secondary" = versionSlugs.has(slug)
      ? "version"
      : "secondary";
    groups.push({ slug, label: slug, members, kind, hidden: hiddenSlugs.has(slug) });
  }

  leaves.sort((a, b) => a.url.localeCompare(b.url));
  groups.sort((a, b) => a.slug.localeCompare(b.slug));
  for (const g of groups) {
    g.members.sort((a, b) => a.url.localeCompare(b.url));
  }

  return { leaves, groups };
}

/**
 * Render the full published corpus as one markdown document — the body of
 * the `llms-full.txt` route. One fetch hands an agent (or a RAG ingestion
 * job) every page as clean markdown, no crawling.
 *
 * Scope matches the root `llms.txt`: the primary `docs` collection plus
 * every secondary collection, **excluding** non-current version collections
 * (`docs-<v>`) — old versions keep their own per-version surfaces and never
 * multiply this document.
 *
 * Contract (see `buildCorpusMarkdown` for the collation rules):
 *   - Entries are sorted by `url`; output is deterministic across rebuilds.
 *   - Each entry is a `#`-level block (bodies render at `##` and below).
 *   - The document header cross-references `/llms.txt`.
 *
 * The starter route stays policy-free and ~10 lines; a site that wants a
 * different corpus (per-version, filtered, chunked) reshapes its own route
 * on top of `getIndexedEntries()` + `renderEntryAsMarkdown()`.
 */
export async function renderCorpusMarkdown(): Promise<string> {
  const config = await loadNimbusConfig();
  const versions = await getVersions();
  const entries = await getIndexedEntries();

  // Exclude non-current version collections — same predicate the root
  // `llms.txt` applies via its `kind === "version"` skip (hidden versions
  // are a subset of `others`, so this covers them too).
  const versionSlugs = new Set(versions?.others ?? []);
  const included = entries.filter(
    (item) =>
      item.collection === PRIMARY_COLLECTION ||
      !versionSlugs.has(resolveCollectionSlug(item.collection, versions)),
  );

  return buildCorpusMarkdown(
    included.map((item) => ({
      title: item.title,
      description: item.description,
      url: item.url,
      markdownUrl: item.markdownUrl,
      markdown: renderEntryAsMarkdown(item.entry),
    })),
    {
      title: config.title,
      description: config.description,
      site: config.site,
    },
  );
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

/**
 * Build the sidebar tree for the given current path, scoped to the
 * top-level section containing that page.
 *
 * Reads `sidebar` from the user's nimbus.config. If `sidebar.items` is set,
 * resolves config-driven sidebar. Otherwise auto-generates from filesystem
 * (i.e. the `docs` collection's entry IDs).
 *
 * Returned shape depends on `sidebar.scope` in `nimbus.config.ts`:
 *   - `"full"` (default) — every top-level item on every page.
 *   - `"section"` — only the current top-level section's children. Use
 *     the header section-tab strip (via `getSidebarSections`) for
 *     cross-section nav when this mode is on.
 *
 * **Versioning awareness.** When the page is in a version collection
 * (`docs-<v>` where `<v>` is in `versions.others`), pass `collection` as
 * the second argument. The sidebar build will swap any
 * `{ autogenerate: { collection: "docs" } }` items to autogenerate from
 * that version's collection instead, and treat it as the primary for
 * the build. Without this, version pages render the current-version
 * sidebar and prev/next derives from the wrong tree.
 *
 * @param currentSlug - The current page's URL path (e.g. "/getting-started").
 *                     Used to set `isCurrent` on matching links and to pick
 *                     which top-level section to surface when scoping.
 * @param options.collection - The current page's Astro collection ID.
 *                     Pass `entry.collection` from your route.
 */
export async function getSidebar(
  currentSlug: string,
  options?: { collection?: string; transform?: SidebarTransform },
): Promise<SidebarItem[]> {
  const config = await loadNimbusConfig();
  const structural = await buildStructuralTree(options?.collection);

  // 1. Scope + materialize.
  let tree: SidebarItem[];
  if (config.sidebar?.scope === "section") {
    tree = scopeToCurrentSection(structural, currentSlug);
  } else {
    tree = cloneSidebarTree(structural);
    markActiveState(tree, currentSlug);
  }

  // 2. Isolate further to a boundary sub-tree (if configured). Runs after
  //    scope, over the already-materialized (mutable) tree.
  const boundaries = config.sidebar?.isolate?.boundaries;
  if (boundaries && boundaries.length > 0) {
    tree = isolateToBoundary(tree, currentSlug, boundaries);
  }

  // 3. Consumer transform (call-site). Ctx is derived read-only from the
  //    frozen structural tree.
  if (options?.transform) {
    const ctx = deriveTransformCtx(structural, currentSlug);
    tree = await options.transform({ tree, currentSlug, ...ctx });
  }

  // 4. Overview-leaf display mode (opt-in) — runs last so it sees the
  //    transform's output (e.g. badges keyed off `indexHref`) and only
  //    reshapes this returned tree, never the cached structural one.
  if (config.sidebar?.indexDisplay === "overview-leaf") {
    const label =
      typeof config.sidebar.overviewLabel === "string"
        ? config.sidebar.overviewLabel
        : "Overview";
    const sectionSlug = currentSlug.split("/").filter(Boolean)[0] ?? "";
    tree = applyOverviewLeaf(tree, sectionSlug, label);
  }

  return tree;
}

/**
 * Derive one section per top-level group in the sidebar — used by
 * `Header.astro` to render the section tab strip (and by any other
 * cross-section navigation).
 *
 * Reads the un-scoped tree so every section is visible, then collapses
 * each top-level group to `{ label, href, isActive }`.
 *
 * Accepts the same `collection` option as `getSidebar` so version pages
 * see version-scoped section tabs.
 */
export async function getSidebarSections(
  currentSlug: string,
  options?: { collection?: string },
): Promise<SidebarSection[]> {
  // Read-only over the frozen structural tree — no per-page clone. Active
  // state is computed from `currentSlug` inside `deriveSidebarSections`.
  const tree = await buildStructuralTree(options?.collection);
  return deriveSidebarSections(tree, currentSlug);
}

// A path that matches no real href, so the cached tree is built with every
// active flag inert; flags are stamped per page by `markActiveState`.
const NO_ACTIVE_PATH = "\u0000__nimbus_structural__";

// Structural tree cached per effective-primary (the only input that changes
// the tree's shape). Cached in dev too — rebuilding the full nav per request
// makes dev unusably slow on large trees; the dev server clears it on content
// change via `clearNavCaches`.
const structuralTreeCache = new Map<string, SidebarItem[]>();

/** Drop all nav caches (dev content-change invalidation). */
export function clearNavCaches(): void {
  structuralTreeCache.clear();
  indexedEntriesCache = undefined;
  clearValidInternalLinksCache();
  clearContentCaches();
}

function deepFreeze(items: readonly SidebarItem[]): void {
  for (const item of items) {
    if (item.type === "group") deepFreeze(item.children);
    Object.freeze(item);
  }
  Object.freeze(items);
}

/**
 * Build the un-scoped, un-marked sidebar tree, cached per effective-primary
 * collection. Callers needing active-state clone it and run `markActiveState`
 * (never mutate the cache).
 *
 * When `pageCollection` is a registered version collection (`docs-<v>`), that
 * collection becomes the primary: autogen items referencing `docs` are
 * rewritten to it and `primaryPrefix` is set, so version pages get the right
 * tree and prev/next ordering.
 */
async function buildStructuralTree(
  pageCollection?: string,
): Promise<SidebarItem[]> {
  const runtimeConfig = await loadNimbusConfig();
  const versions = await getVersions();

  // Resolve the effective "primary" collection for THIS sidebar build.
  // For pages in a non-current version collection, the primary IS that
  // collection (the sidebar should walk docs-v0, not docs).
  let effectivePrimary = PRIMARY_COLLECTION;
  let primaryPrefix = "";
  if (
    versions &&
    pageCollection &&
    pageCollection.startsWith("docs-") &&
    versions.others.includes(pageCollection.slice("docs-".length))
  ) {
    effectivePrimary = pageCollection;
    primaryPrefix = resolveCollectionPrefix(pageCollection, versions);
  }

  const cached = structuralTreeCache.get(effectivePrimary);
  if (cached) return cached;

  // Rewrite sidebar items so `{ autogenerate: { collection: "docs" } }`
  // becomes `{ autogenerate: { collection: "docs-v0" } }` on v0 pages.
  // Items that name a different collection (api, blog) are untouched —
  // they keep their global scope.
  // Cast at the boundary: `runtimeConfig.sidebar?.items` is `unknown[] | undefined`
  // because runtimeConfig is loaded through a virtual module whose data is
  // already Zod-validated at integration setup (`validateNimbusConfig`).
  // The cast restores the shape downstream functions expect.
  const rewrittenItems = (
    effectivePrimary !== PRIMARY_COLLECTION
      ? rewriteSidebarItemsForVersion(
          runtimeConfig.sidebar?.items,
          effectivePrimary,
        )
      : runtimeConfig.sidebar?.items
  ) as Parameters<typeof collectSidebarCollectionRefs>[0];

  const referenced = collectSidebarCollectionRefs(rewrittenItems);
  const collections = [
    effectivePrimary,
    ...referenced.filter((c) => c !== effectivePrimary),
  ];
  const entriesByCollection = await getVisibleEntriesByCollection(collections);
  const tree = buildSidebarTree(
    // Cast: `astro:content` `CollectionEntry<string>` has `data: Record<string, unknown>`
    // in our stub; sidebar.ts's local `CollectionEntry` shapes `data` with `title`
    // required. Runtime entries always carry `title` (schema-enforced); the cast
    // documents that guarantee. `unknown` bridge is required because the two
    // CollectionEntry shapes don't structurally overlap on the `data` field.
    entriesByCollection as unknown as Parameters<typeof buildSidebarTree>[0],
    effectivePrimary,
    NO_ACTIVE_PATH,
    runtimeConfig.sidebar
      ? { ...runtimeConfig.sidebar, items: rewrittenItems }
      : undefined,
    primaryPrefix,
  );

  // Frozen because it's shared across pages and its nodes reach user
  // `resolveLabel` via `getBreadcrumbs`; consumers clone before stamping.
  deepFreeze(tree);
  structuralTreeCache.set(effectivePrimary, tree);
  return tree;
}

/**
 * Substitute the primary collection (`docs`) for `effectivePrimary`
 * inside any sidebar item that autogenerates from a named collection.
 * Used by `buildStructuralTree` to make version pages render their
 * own collection's sidebar instead of the current version's.
 */
function rewriteSidebarItemsForVersion(
  items: unknown[] | undefined,
  effectivePrimary: string,
): unknown[] | undefined {
  if (!items) return items;
  return items.map((item) => {
    if (!item || typeof item !== "object") return item;
    const o = item as Record<string, unknown>;
    const autogen = o.autogenerate as { collection?: string; directory?: string } | undefined;
    if (autogen && autogen.collection === PRIMARY_COLLECTION) {
      return { ...o, autogenerate: { ...autogen, collection: effectivePrimary } };
    }
    // Nested groups recurse so per-group autogen items rewrite too.
    if (Array.isArray(o.items)) {
      return { ...o, items: rewriteSidebarItemsForVersion(o.items, effectivePrimary) };
    }
    return item;
  });
}

/**
 * Resolve prev/next links for the current page.
 *
 * Walks the flattened sidebar; returns the surrounding entries. Honors
 * `prev`/`next` frontmatter overrides if provided.
 *
 * When an override uses the object form with an internal `link`
 * (e.g. `prev: { link: "/getting-started" }`), the link is validated
 * against every visible content entry's URL at build time. A pointer
 * to a missing page fails the build with a clear error — the same
 * staleness-detection mechanism used for `previousSlug` in versioning.
 * The string form (`prev: "Custom label"`) is a label-only override
 * and doesn't go through link validation.
 */
export async function getPrevNext(
  currentSlug: string,
  options?: {
    overrides?: PrevNextOverrides;
    sidebarTree?: SidebarItem[];
  },
): Promise<PrevNext> {
  const tree = options?.sidebarTree ?? (await getSidebar(currentSlug));
  // Build the set of valid internal route keys (slashless) from indexed
  // entries so object-form `prev: { link: "/x" }` overrides fail loudly
  // when the target doesn't exist. The set holds route keys, not browser
  // hrefs, so a `/cli`, `/cli/`, or `/cli/?ref=x` override all resolve
  // to the same canonical entry. Cheap: indexed entries are cached per
  // build.
  const indexed = await getIndexedEntries();
  const validInternalLinks = getValidInternalLinks(indexed);
  return buildPrevNext(currentSlug, tree, options?.overrides, validInternalLinks);
}

/**
 * Build the breadcrumb trail from the active node's ancestry in the nav
 * tree. Labels come from nav nodes, hrefs from each node's landing — so a
 * section crumb links to its real landing page and segments with no node
 * never appear. Index-less folders render as non-interactive crumbs.
 *
 * - `collection` — the page's Astro collection; pass `entry.collection` so
 *   versioned pages get version-prefixed hrefs.
 * - `root` — the leading crumb (default `{ label: "Home", href: "/" }`).
 * - `resolveLabel` — override a crumb label, or return `null` to drop it.
 *
 * Falls back to URL-segment derivation when the page has no node in the
 * tree, so a stray page still gets a root-anchored trail.
 */
export async function getBreadcrumbs(
  currentSlug: string,
  options?: { collection?: string } & BreadcrumbOptions,
): Promise<Breadcrumb[]> {
  // `findActivePath` matches by href, so the un-marked tree suffices (no clone).
  const tree = await buildStructuralTree(options?.collection);
  const path = findActivePath(tree, currentSlug);

  if (path.length > 0) {
    const root = options?.root ?? { label: "Home", href: "/" };
    const labels = await Promise.all(
      path.map((node) =>
        Promise.resolve(options?.resolveLabel?.({ node, slug: currentSlug })),
      ),
    );
    return assembleBreadcrumbs(root, path, labels);
  }

  return breadcrumbsFromUrl(currentSlug, options?.root?.label ?? "Home");
}

/** Resolves a section's display titles. May be async. */
export type SectionTitleResolver = (ctx: {
  sectionSlug: string;
  module?: string;
  indexEntryId?: string;
}) => SectionTitle | undefined | Promise<SectionTitle | undefined>;

/** A section's rail and breadcrumb titles, which may differ. */
export interface SectionTitle {
  rail?: string;
  breadcrumb?: string;
}

/**
 * Resolve a section's display title(s) for the current page, decoupled so
 * the rail header and the breadcrumb can differ.
 *
 * Derives `sectionSlug` (seg0) and `module` (seg1) from the slug and passes
 * them to a caller-supplied resolver. The resolver is an argument rather
 * than config because config is JSON-serialized and cannot carry functions.
 * `indexEntryId` is currently always `undefined`.
 */
export async function getSectionTitle(
  currentSlug: string,
  resolve: SectionTitleResolver,
): Promise<SectionTitle | undefined> {
  const segs = currentSlug.split("/").filter(Boolean);
  const sectionSlug = segs[0];
  if (!sectionSlug) return undefined;
  return resolve({ sectionSlug, module: segs[1], indexEntryId: undefined });
}

export interface RouteNavigationOptions {
  /** The current route's pathname. */
  path: string;
  /** A real nav node URL to mark active and end the ancestry trail at. */
  section: string;
  /** Crumbs appended after the section trail; a leaf with no href is current. */
  trail?: Breadcrumb[];
  /** When `false` (default), prev/next is omitted. */
  prevNext?: boolean;
  /** The page's collection, for version-prefixed hrefs. */
  collection?: string;
  /** Forwarded to the internal breadcrumb build. */
  resolveLabel?: BreadcrumbOptions["resolveLabel"];
}

export interface RouteNavigation {
  breadcrumbs: Breadcrumb[];
  sidebar: SidebarItem[];
  /** The href marked active in the sidebar (the `section`). */
  activeHref: string;
  prevNext?: PrevNext;
}

/**
 * Navigation (breadcrumbs, sidebar active-state, optional prev/next) for a
 * data-driven route with no content entry of its own — e.g. a catalog page
 * under `src/pages/[...].astro`.
 *
 * Builds the breadcrumb trail to `section` (a real nav node) and appends
 * `trail` (the leaf). The sidebar is built with `section` as the active
 * path, so the section node highlights even though the leaf is not in the
 * tree — the leaf is never injected, keeping the tree and prev/next clean.
 */
export async function getRouteNavigation(
  options: RouteNavigationOptions,
): Promise<RouteNavigation> {
  const { section, trail = [], prevNext = false, collection, resolveLabel } = options;

  const sidebar = await getSidebar(section, { collection });
  const sectionCrumbs = await getBreadcrumbs(section, { collection, resolveLabel });
  const breadcrumbs = composeRouteBreadcrumbs(sectionCrumbs, trail);

  let pn: PrevNext | undefined;
  if (prevNext) {
    pn = await getPrevNext(section, { sidebarTree: sidebar });
  }

  return { breadcrumbs, sidebar, activeHref: section, prevNext: pn };
}

/**
 * Build an edit URL for a content entry using `config.editPattern`.
 *
 * `{path}` is replaced with the entry's source path when Astro provides it,
 * falling back to the default docs collection path convention.
 */
export async function getEditUrl(entry: {
  id: string;
  filePath?: string;
}): Promise<string | undefined> {
  const runtimeConfig = await loadNimbusConfig();
  if (!runtimeConfig.editPattern) return undefined;

  const path = entry.filePath ?? `src/content/docs/${entry.id}.mdx`;
  return runtimeConfig.editPattern.replace("{path}", path);
}

/**
 * Resolve a content entry's `lastUpdated` date from `git log`.
 *
 * Reads the author date (`%aI`) of the most recent commit that touched
 * the entry's source file. Author date is stable across rebases — the
 * value reflects when the content was actually changed, not when the
 * commit happened to land in this branch.
 *
 * Returns `undefined` when git can't answer (no `.git`, shallow clone,
 * file untracked, command not on PATH, etc.) so the caller can chain a
 * fallback:
 *
 *   const lastUpdated = entry.data.lastUpdated ?? await getLastUpdated(entry);
 *
 * Frontmatter always wins. Per-process cached so repeated calls for
 * the same entry don't re-spawn `git`.
 *
 * Production note: most CI/CD systems do shallow clones by default
 * (Vercel, Cloudflare Pages, GitHub Actions checkout@v4) — set
 * `fetch-depth: 0` to make full history available, otherwise git
 * returns nothing and the helper falls back to frontmatter or nothing.
 */
export async function getLastUpdated(entry: {
  id: string;
  filePath?: string;
}): Promise<Date | undefined> {
  const path = entry.filePath ?? `src/content/docs/${entry.id}.mdx`;
  return getLastUpdatedFromGit(path);
}

/**
 * Filter heading list to the configured min/max heading levels.
 *
 * @param headings - Raw `headings` from Astro's `render(entry)` return value.
 * @param options - Override min/max heading levels. Defaults: min=2, max=3.
 */
export function getTOC(
  headings: { depth: number; text: string; slug: string }[],
  options?: { minHeadingLevel?: number; maxHeadingLevel?: number },
): TOCItem[] {
  return getHeadings(headings, options);
}

// ---------------------------------------------------------------------------
// Page composition helpers
// ---------------------------------------------------------------------------

import type { AstroGlobal, GetStaticPaths } from "astro";

/**
 * `getStaticPaths` implementation for a docs catch-all route.
 *
 * Returns one path per visible entry in the `docs` collection. Drafts are
 * filtered in production. Each path passes `{ entry }` as props so the
 * page component can access it via `getDocsPageProps(Astro)`.
 *
 * Usage:
 *
 *   // src/pages/[...slug].astro
 *   export const prerender = true;
 *   export const getStaticPaths = getDocsStaticPaths;
 *
 * The entry's `id` is used verbatim as the slug. So `docs/index.mdx` →
 * `/index`, `docs/guides/setup.mdx` → `/guides/setup`. If you want a docs
 * entry at the root URL, name it appropriately and decide whether to use
 * a static `pages/index.astro` or let the catch-all handle root.
 */
export const getDocsStaticPaths: GetStaticPaths = async () => {
  // Docs-specific helper: always reads the `docs` collection. Other
  // collections require their own `pages/<name>/[...slug].astro` with
  // a one-line `getCollection("<name>")`-based getStaticPaths.
  const entries = await getVisibleEntries(["docs"]);
  return entries.map((entry) => ({
    params: { slug: entry.id },
    props: { entry },
    // Opt this route into Astro's experimental incremental static builds.
    // Ignored unless `experimental.incrementalBuild` is enabled.
    cacheKey: entryCacheKey(entry),
  }));
};

/**
 * Read the current entry from `Astro.props`, render it, and return the
 * pieces a docs page needs: the typed entry, the renderable `<Content />`
 * component, and the headings list (for TOC generation).
 *
 * Headings from `<Render file="..." />` partials are recursively merged
 * into the returned list in document order. Pass `partialHeadings:
 * { resolvePartialId }` to customise how `<Render>` attributes map to
 * a partial collection id (e.g. cloudflare-docs' `product` convention).
 *
 * Pass the page's `Astro` global. Throws if `Astro.props.entry` is missing,
 * which indicates the page didn't wire `getDocsStaticPaths` (or a custom
 * equivalent) correctly.
 *
 * Usage:
 *
 *   const { entry, Content, headings } = await getDocsPageProps(Astro);
 *
 * With a custom partial-id resolver:
 *
 *   const { entry, Content, headings } = await getDocsPageProps(Astro, {
 *     partialHeadings: {
 *       resolvePartialId: ({ file, product }) =>
 *         product ? `${product}/${file}` : file,
 *     },
 *   });
 */
export async function getDocsPageProps(
  astro: AstroGlobal,
  options?: { partialHeadings?: PartialHeadingOptions },
): Promise<{
  entry: import("astro:content").CollectionEntry<"docs">;
  Content: import("astro/runtime/server/index.js").AstroComponentFactory;
  headings: { depth: number; text: string; slug: string }[];
}> {
  const entry = (astro.props as { entry?: import("astro:content").CollectionEntry<"docs"> })
    .entry;
  if (!entry) {
    throw new Error(
      "getDocsPageProps(): expected `entry` in Astro.props. " +
        "Ensure your route uses `getStaticPaths = getDocsStaticPaths` " +
        "(or passes an entry via custom getStaticPaths).",
    );
  }
  const { render, getEntry } = await import("astro:content");
  const { Content, headings } = await render(entry);
  const merged = await mergePartialHeadings(
    entry.body,
    headings,
    getEntry as (collection: string, id: string) => Promise<unknown>,
    render as (entry: unknown) => Promise<{ headings: typeof headings }>,
    options?.partialHeadings,
  );
  return { entry, Content, headings: merged };
}

/**
 * Resolve a docs route's layout flags: merge the site-wide feature toggles with
 * per-page frontmatter into the single source of truth for whether a page gets
 * a sidebar / TOC column, so layouts stay presentational.
 */
export async function getRouteFlags(entry: {
  data: { mode?: string; sidebar?: unknown; tableOfContents?: unknown };
}): Promise<{ sidebar: boolean; tableOfContents: boolean }> {
  const config = await loadNimbusConfig();
  const isCustom = entry.data.mode === "custom";
  return {
    sidebar:
      !isCustom &&
      config.features?.sidebar !== false &&
      entry.data.sidebar !== false,
    tableOfContents:
      !isCustom &&
      config.features?.tableOfContents !== false &&
      entry.data.tableOfContents !== false,
  };
}

/**
 * `getStaticPaths` implementation for a catch-all route over a non-primary
 * collection (`api`, `blog`, …). Companion to `getDocsStaticPaths`.
 *
 * Returns one path per visible entry in the named collection. Drafts are
 * filtered in production (same rule as `getDocsStaticPaths`). Each path
 * passes `{ entry }` as props for `getCollectionPageProps()`.
 *
 * Usage:
 *
 *   // src/pages/api/[...slug].astro
 *   export const prerender = true;
 *   export const getStaticPaths = getCollectionStaticPaths("api");
 *
 * Why a sibling helper instead of an option on `getDocsStaticPaths`: the
 * `Docs` name carries the "primary collection mounted at root" semantic.
 * Non-primary collections mount under their own URL namespace
 * (`/<collection>/...`) by convention; the helper name reflects that.
 */
export function getCollectionStaticPaths(collection: string): GetStaticPaths {
  return async () => {
    const entries = await getVisibleEntries([collection]);
    return entries.map((entry) => ({
      params: { slug: entry.id },
      props: { entry },
      // See `getDocsStaticPaths` — opt into experimental incremental builds.
      cacheKey: entryCacheKey(entry),
    }));
  };
}

/**
 * Read the current entry from `Astro.props`, render it, and return the
 * pieces a docs-style page needs — typed for an arbitrary collection.
 *
 * Companion to `getCollectionStaticPaths`. Use this in routes mounted at
 * non-primary collections (`api`, `blog`, …) instead of `getDocsPageProps`,
 * which is typed to the `docs` collection.
 *
 * Headings from `<Render file="..." />` partials are recursively merged
 * into the returned list in document order. See `getDocsPageProps` for
 * the `partialHeadings` option.
 *
 * Pass the collection name as a type parameter for the entry's data
 * shape to narrow correctly:
 *
 *   const { entry, Content, headings } = await getCollectionPageProps<"api">(Astro);
 */
export async function getCollectionPageProps<C extends string>(
  astro: AstroGlobal,
  options?: { partialHeadings?: PartialHeadingOptions },
): Promise<{
  entry: import("astro:content").CollectionEntry<C>;
  Content: import("astro/runtime/server/index.js").AstroComponentFactory;
  headings: { depth: number; text: string; slug: string }[];
}> {
  const entry = (astro.props as { entry?: import("astro:content").CollectionEntry<C> })
    .entry;
  if (!entry) {
    throw new Error(
      "getCollectionPageProps(): expected `entry` in Astro.props. " +
        "Ensure your route uses `getStaticPaths = getCollectionStaticPaths(<collection>)`.",
    );
  }
  const { render, getEntry } = await import("astro:content");
  const { Content, headings } = await render(entry);
  const merged = await mergePartialHeadings(
    entry.body,
    headings,
    getEntry as (collection: string, id: string) => Promise<unknown>,
    render as (entry: unknown) => Promise<{ headings: typeof headings }>,
    options?.partialHeadings,
  );
  return { entry, Content, headings: merged };
}

// ---------------------------------------------------------------------------
// Versioning (data layer)
// ---------------------------------------------------------------------------

/**
 * Return the resolved versioning manifest for the current site, or `null`
 * if the site is unversioned (`nimbus.config.ts` has no `versions` block).
 *
 * Optional fields are normalised to empty arrays (`deprecated`, `hidden`)
 * and `all` is `[current, ...others]` in manifest order — convenient for
 * picker enumeration or anywhere you need every known version slug.
 *
 * Usage:
 *
 *   const versions = await getVersions();
 *   if (versions) {
 *     for (const slug of versions.all) {
 *       // …enumerate
 *     }
 *   }
 *
 * Reads from `virtual:nimbus/config`, so the cost is one cached dynamic
 * import per build.
 */
export async function getVersions(): Promise<ResolvedVersions | null> {
  const config = await loadNimbusConfig();
  const v = config.versions;
  if (!v) return null;
  const others = v.others ?? [];
  return {
    current: v.current,
    others,
    deprecated: v.deprecated ?? [],
    hidden: v.hidden ?? [],
    all: [v.current, ...others],
  };
}

/**
 * Return the version slug a given Astro content collection ID belongs to,
 * or `null` if the collection is not a version of the primary docs.
 *
 * Rules:
 *   - `"docs"` → `versions.current` (the current version's label).
 *   - `"docs-<slug>"` where `<slug>` appears in `versions.current` or
 *     `versions.others` → `<slug>`.
 *   - Anything else (e.g. `"blog"`, `"api"`, `"docs-archive"` when
 *     `archive` isn't in the manifest) → `null`.
 *
 * Returns `null` whenever the site has no `versions` config at all,
 * regardless of collection ID.
 *
 * Usage in a route:
 *
 *   const { entry } = Astro.props;
 *   const version = await getCurrentVersion(entry.collection);
 *   // version === "v3" for entries in `docs`, "v2" for entries in `docs-v2`, …
 */
export async function getCurrentVersion(
  collectionId: string,
): Promise<string | null> {
  const versions = await getVersions();
  if (!versions) return null;
  if (collectionId === PRIMARY_COLLECTION) return versions.current;
  if (!collectionId.startsWith("docs-")) return null;
  const suffix = collectionId.slice("docs-".length);
  return versions.all.includes(suffix) ? suffix : null;
}

/**
 * Look up the cross-version alternates for a given Astro entry.
 *
 * Returns `null` when the entry is not part of a versioning manifest
 * (unversioned site, non-`docs` collection like `blog`/`api`, or the
 * lookup misses for any other reason). Otherwise returns a record with:
 *
 *   - `self`: the entry being looked up, expressed as a `VersionPageRef`.
 *   - `alternates`: every other version's sibling page for the same
 *     logical content (same slug or linked via `previousSlug`). Sorted
 *     in manifest version order.
 *   - `canonical`: the current-version sibling when one exists and
 *     isn't `self`. `null` when `self` is already the current version
 *     or no current-version sibling exists.
 *
 * Routes inject `<link rel="alternate">` for every entry in
 * `alternates`, and `<link rel="canonical">` pointing at `canonical.url`
 * when canonical is non-null.
 *
 * Usage in a route:
 *
 *   const { entry } = Astro.props;
 *   const alts = await getVersionAlternates(entry.collection, entry.id);
 *
 *   {alts?.alternates.map((a) => (
 *     <link rel="alternate" data-version={a.version} href={a.url} />
 *   ))}
 *   {alts?.canonical && <link rel="canonical" href={alts.canonical.url} />}
 */
export async function getVersionAlternates(
  collectionId: string,
  entryId: string,
): Promise<VersionAlternateRecord | null> {
  const table = await loadVersionAlternates();
  const key = `${collectionId}:${entryId}`;
  return table[key] ?? null;
}

/**
 * Convenience wrapper: returns just the canonical URL for an entry, or
 * `null` when none applies. Equivalent to
 * `(await getVersionAlternates(c, e))?.canonical?.url ?? null` — handy
 * when a route only needs the canonical and not the full alternates list.
 */
export async function getCanonicalUrl(
  collectionId: string,
  entryId: string,
): Promise<string | null> {
  const record = await getVersionAlternates(collectionId, entryId);
  return record?.canonical?.url ?? null;
}

/**
 * Return the agent index URL path (the `/llms.txt` route) that
 * corresponds to a given Astro collection. The path is mount-point
 * aware: pages in version collections point at the per-version index,
 * pages in non-primary collections point at their per-collection index,
 * and the primary `docs` collection points at the root.
 *
 *   - `"docs"`        → `"/llms.txt"`
 *   - `"docs-v1"`     → `"/v1/llms.txt"`     (when `v1` is in `versions.others`)
 *   - `"blog"`        → `"/blog/llms.txt"`
 *   - `"api"`         → `"/api/llms.txt"`
 *   - `"docs-archive"` (unrecognised version slug) → `"/docs-archive/llms.txt"`
 *
 * Returns a path with a leading slash and no trailing slash. Routes
 * resolve it against `Astro.site` to produce a full URL.
 *
 * Used by `BaseLayout` and `AgentDirective` to surface the correct
 * agent index hint on every page — readers landing on `/v1/foo` get
 * pointed at `/v1/llms.txt`, not `/llms.txt`, so agents don't crawl
 * the wrong section.
 */
export async function getCollectionLlmsUrl(
  collectionId: string,
): Promise<string> {
  if (collectionId === PRIMARY_COLLECTION) return "/llms.txt";
  const versions = await getVersions();
  if (versions && collectionId.startsWith("docs-")) {
    const slug = collectionId.slice("docs-".length);
    if (versions.others.includes(slug)) {
      // Hidden versions do NOT emit a per-section /<v>/llms.txt — the
      // [section] route filters them out. Pointing readers at a 404
      // breaks the agent-discovery contract. Fall back to the root
      // index for hidden version pages instead.
      if (versions.hidden.includes(slug)) return "/llms.txt";
      return `/${slug}/llms.txt`;
    }
  }
  return `/${collectionId}/llms.txt`;
}

/**
 * Look up the versioning status for a page's collection — what the
 * layout needs to decide whether to render the deprecation banner,
 * apply the Pagefind facet filters, or exclude the page from search
 * entirely.
 *
 * Returns `null` when the site is unversioned or the page is not part
 * of a version collection (regular `docs`, `blog`, `api`, …). Layouts
 * treat that as "no versioning UI to apply" — render normally.
 *
 * Usage:
 *
 *   const status = await getVersionStatus(entry.collection);
 *   if (status?.isDeprecated) {
 *     // render the deprecation banner
 *   }
 */
/**
 * Resolve a URL that's guaranteed to exist within a given version's
 * collection. Used by the picker (and any other "jump to that version"
 * surface) to avoid landing readers on a 404 when the current page has
 * no same-logical-page sibling in the target version.
 *
 * Resolution order:
 *   1. If `docs-<v>/index` exists, return its URL (the conventional
 *      "version landing page").
 *   2. If `docs-<v>/overview` exists, return its URL (common alternate
 *      name for a landing page).
 *   3. Otherwise return the first indexed entry's URL in that version,
 *      sorted by URL — matches `getIndexedTopLevel()`'s sort so the
 *      choice is deterministic across builds.
 *   4. If the version has no indexed entries at all, return `null`.
 *      Callers should treat that as "this version has nothing to link
 *      to" and either omit the picker entry or fall back to the
 *      version's URL prefix root (which may still 404, but that's the
 *      authoring problem to fix, not the picker's).
 *
 * `version` is the manifest slug (e.g. `"v0"`), NOT the collection ID
 * (`"docs-v0"`). For the current version, returns `"/"` when at least
 * one current-version entry exists, else `null`.
 *
 * Reads from `getIndexedEntries()`, so the cost is one cached lookup
 * per build (the indexed list is computed once per page render).
 */
export async function getVersionLandingUrl(
  version: string,
): Promise<string | null> {
  const versions = await getVersions();
  if (!versions) return null;
  if (!versions.all.includes(version)) return null;

  const targetCollection =
    version === versions.current ? PRIMARY_COLLECTION : `docs-${version}`;
  const items = await getIndexedEntries();
  const inVersion = items.filter((i) => i.collection === targetCollection);
  if (inVersion.length === 0) return null;

  const byId = new Map(inVersion.map((i) => [i.entry.id, i]));
  // Prefer index / overview by convention.
  const preferred = byId.get("index") ?? byId.get("overview");
  // `IndexedEntry.url` is already the trailing-slash browser-href form
  // the version picker renders, so no extra normalization here.
  if (preferred) return preferred.url;
  // Else first by URL (sort is alphabetical → deterministic).
  inVersion.sort((a, b) => a.url.localeCompare(b.url));
  return inVersion[0]!.url;
}

export async function getVersionStatus(
  collectionId: string,
): Promise<VersionStatus | null> {
  const versions = await getVersions();
  if (!versions) return null;
  const version = await getCurrentVersion(collectionId);
  if (version === null) return null;
  return {
    version,
    isCurrent: version === versions.current,
    isDeprecated: versions.deprecated.includes(version),
    isHidden: versions.hidden.includes(version),
  };
}
