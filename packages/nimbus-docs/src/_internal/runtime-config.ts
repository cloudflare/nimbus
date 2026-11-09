/**
 * Runtime config bridge.
 *
 * Reads the user's validated NimbusConfig from `virtual:nimbus/config`,
 * which is provided by the Vite plugin our integration registers.
 *
 * **The import is dynamic on purpose.** Astro's config loader (in plain
 * Node) eagerly imports the whole framework bundle when it loads our
 * default export from `astro.config.ts`. A top-level static
 * `import "virtual:..."` would crash there because Vite hasn't booted
 * yet. Dynamic import keeps the load deferred until a page actually
 * calls a helper at request/render time.
 */

import type { RuntimeNimbusConfig } from "../types.js";
import type { VersionAlternatesTable } from "./version-alternates.js";
import type { MountContext } from "./collection-mount.js";
import type { UnreadRoute } from "./collection-routes.js";
import { setLinkPolicy } from "./url.js";

// `virtual:nimbus/config` declarations live at
// `packages/nimbus-docs/src/types/virtual-modules.d.ts` so they're ambient
// (resolvable from dynamic `await import()` calls below) rather than
// scoped to this module.

let _cached: RuntimeNimbusConfig | null = null;
let _cachedCollections: readonly string[] | null = null;
let _cachedEmptyCollections: readonly string[] | null = null;
let _cachedPrimaryCollectionAbsent: boolean | null = null;
let _cachedRequestRenderingCollections: readonly string[] | null = null;
let _cachedAlternates: VersionAlternatesTable | null = null;
let _cachedApiCollections: readonly string[] | null = null;

// Runtime config reads go through here, so generated hrefs follow Astro's URL
// shape before any helper builds one.
async function virtualConfig(): Promise<typeof import("virtual:nimbus/config")> {
  const [mod, astroConfig] = await Promise.all([
    import("virtual:nimbus/config"),
    import("astro:config/client"),
  ]);
  setLinkPolicy({ trailingSlash: astroConfig.trailingSlash, format: astroConfig.build.format });
  return mod;
}

let _cachedMountContext: MountContext | null = null;

/** What collection URLs depend on: the configured versions and the route map the build resolved. */
export async function loadMountContext(): Promise<MountContext> {
  if (_cachedMountContext) return _cachedMountContext;
  const mod = await virtualConfig();
  const versions = mod.config.versions;
  _cachedMountContext = {
    versions: versions ? { others: versions.others ?? [] } : null,
    routes: new Map(mod.collectionRoutes ?? []),
  };
  return _cachedMountContext;
}

/** The search scope table (`search-scope.ts`). */
export async function loadSearchScope(): Promise<import("./search-scope.js").SearchScopeTable> {
  return (await virtualConfig()).searchScope ?? { pairs: [], docs: {}, apis: {} };
}

/** Static-folder routes that import a route helper in a shape the build couldn't read. */
export async function loadUnreadCollectionRoutes(): Promise<readonly UnreadRoute[]> {
  return (await virtualConfig()).unreadCollectionRoutes ?? [];
}

/** Whether the section `llms.txt` route serves nested sections (`[...section]`). */
export async function loadNestedLlmsSections(): Promise<boolean> {
  return (await virtualConfig()).nestedLlmsSections ?? false;
}

export async function loadNimbusConfig(): Promise<RuntimeNimbusConfig> {
  if (_cached) return _cached;
  const mod = await virtualConfig();
  // Intermediate const so the return path isn't typed `NimbusConfig | null`
  // (the module-scoped `_cached` keeps its union; the value being cached
  // and returned is the same object — observable behavior is identical).
  const value = mod.config;
  _cached = value;
  return value;
}

/**
 * The page-collection list the agent-facing routes (llms.txt, per-page .md
 * alternates) iterate: collections made with Nimbus's helpers (role `page`
 * in the prepared-markdown registry) plus configured API collections, in
 * deterministic order. See `getIndexedEntries()` and `page-collections.ts`.
 */
export async function loadIndexedCollections(): Promise<readonly string[]> {
  if (_cachedCollections) return _cachedCollections;
  const mod = await virtualConfig();
  const value = mod.indexedCollections;
  _cachedCollections = value;
  return value;
}

/**
 * Page collections a partial build left empty on purpose. Empty in a full
 * build, in dev, and when the virtual module predates the field.
 */
export async function loadEmptyCollections(): Promise<readonly string[]> {
  if (_cachedEmptyCollections) return _cachedEmptyCollections;
  const mod = await virtualConfig();
  const value = mod.emptyCollections ?? [];
  _cachedEmptyCollections = value;
  return value;
}

/**
 * Whether `content.config.ts` provably declares no `docs` collection: a
 * complete parse without it. False when the parse isn't complete (spreads,
 * indirect exports) and when the virtual module predates the field.
 */
export async function loadPrimaryCollectionAbsent(): Promise<boolean> {
  if (_cachedPrimaryCollectionAbsent !== null) return _cachedPrimaryCollectionAbsent;
  const mod = await virtualConfig();
  _cachedPrimaryCollectionAbsent = mod.primaryCollectionAbsent ?? false;
  return _cachedPrimaryCollectionAbsent;
}

export async function loadRequestRenderingCollections(): Promise<readonly string[]> {
  if (_cachedRequestRenderingCollections) return _cachedRequestRenderingCollections;
  const mod = await virtualConfig();
  const value = mod.requestRenderingCollections ?? [];
  _cachedRequestRenderingCollections = value;
  return value;
}

/**
 * Build-time-resolved alternates table for cross-version SEO links.
 * Returns the same object on every call (cached after first load).
 * Empty `{}` when the site is unversioned.
 */
export async function loadVersionAlternates(): Promise<VersionAlternatesTable> {
  if (_cachedAlternates) return _cachedAlternates;
  const mod = await virtualConfig();
  // Fall back to an empty table when the virtual module doesn't define
  // `versionAlternates` (e.g. older integration build, or transient
  // dev-server cache state). Downstream lookups (`table[key] ?? null`)
  // then resolve cleanly instead of throwing on an undefined receiver.
  const value = mod.versionAlternates ?? {};
  _cachedAlternates = value;
  return value;
}

/**
 * Which indexed collections are OpenAPI reference collections. Render-time
 * Markdown dispatch uses this to route API entries through the emitter.
 * Empty array when the virtual module predates the field.
 */
export async function loadApiCollections(): Promise<readonly string[]> {
  if (_cachedApiCollections) return _cachedApiCollections;
  const mod = await virtualConfig();
  const value = mod.apiCollections ?? [];
  _cachedApiCollections = value;
  return value;
}
