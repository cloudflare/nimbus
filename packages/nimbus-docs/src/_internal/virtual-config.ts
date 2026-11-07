/**
 * Vite plugin: exposes the validated NimbusConfig via `virtual:nimbus/config`.
 *
 * Consumers in user-land:
 *
 *   import { config, indexedCollections, versionAlternates }
 *     from "virtual:nimbus/config";
 *
 * Used by data helpers (getSidebar, getPrevNext, etc.) so they don't need
 * the config passed at every call site. The `indexedCollections` export is
 * the page-collection list: the collections Nimbus's helpers loaded (role
 * `page` in the prepared-markdown registry) plus the configured API
 * collections. It is read from the registry record when the module loads —
 * after content sync in both build and dev — never parsed from
 * `content.config.ts`. See `page-collections.ts` and `getIndexedEntries()`.
 *
 * `versionAlternates` is the build-time alternates table for cross-version
 * SEO links (`<link rel="alternate">`, `<link rel="canonical">`). Empty
 * object when the site is unversioned. See `version-alternates.ts`.
 */

import { refreshDevRunners, type DevServerGraphs } from "./dev-invalidation.js";
import type { NimbusConfig, RuntimeContentSource, RuntimeNimbusConfig } from "../types.js";
import { searchIndexLayout } from "./build-slice.js";
import { NO_ROUTES } from "./collection-mount.js";
import type { CollectionRoutes, UnreadRoute } from "./collection-routes.js";
import type { VersionAlternatesTable } from "./version-alternates.js";

const VIRTUAL_ID = "virtual:nimbus/config";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

export interface VitePluginLike {
  name: string;
  enforce?: "pre" | "post";
  resolveId(id: string, importer?: string): string | undefined;
  load(id: string): string | undefined | Promise<string | undefined>;
  handleHotUpdate?(context: { file: string; server: DevServerGraphs }): void;
}

export interface VirtualConfigExtras {
  getPageAssets?: () => Record<string, Record<string, string>>;
  getNavLists?: () => Record<string, Record<string, string>>;
  getApiLists?: () => Record<string, Record<string, string>>;
  /**
   * The ordered page-collection list, read from the prepared-markdown
   * registry record. Awaited when the virtual module loads, which is after
   * content sync, so it waits for loads still in progress.
   */
  getIndexedCollections: () => Promise<readonly string[]>;
  /**
   * Page collections a partial build (`NIMBUS_BUILD_ONLY`) left empty on
   * purpose. The indexed-entry path skips them instead of asking Astro,
   * which would warn once per collection on every request-rendered
   * request. Empty in a full build and in dev.
   */
  getEmptyCollections?: () => Promise<readonly string[]>;
  /**
   * Whether `content.config.ts` provably declares no `docs`, so the sidebar
   * doesn't query it. Builds only: dev keeps querying, since a config edit
   * doesn't reach the running server's cached answer.
   */
  getPrimaryCollectionAbsent?: () => Promise<boolean>;
  /**
   * The partial build this is, or null: its collections and the prefix its
   * site-wide files live under (`""` for a root slice), with the Pagefind
   * bundle the search client loads and the other slices' bundles it merges
   * (served URLs, base included).
   */
  getBuildSlice?: () => Promise<{
    collections: readonly string[];
    prefix: string;
    search: { bundle: string; merge: readonly string[] };
  } | null>;
  requestRenderingCollections: string[];
  /** Astro's `base`, for the whole-site search bundle's served URL. */
  base: string;
  /**
   * Build-time alternates table for cross-version SEO links. Empty `{}`
   * when the site is unversioned or has only the current version.
   */
  versionAlternates: VersionAlternatesTable;
  /**
   * Subset of `indexedCollections` that are OpenAPI reference collections.
   * Render-time Markdown dispatch (`renderIndexedEntryMarkdown`) keys off
   * this to route API entries through the emitter. Read only in prerendered
   * server endpoints — never a client component.
   */
  apiCollections: string[];
  /** Collections served by a route helper, by where the route file is. */
  collectionRoutes: CollectionRoutes;
  /** Static-folder routes that import a route helper in a shape the build couldn't read. */
  unreadCollectionRoutes: readonly UnreadRoute[];
  /** Whether the section `llms.txt` route serves nested sections, once routes are resolved. */
  getNestedLlmsSections?: () => boolean;
  headDefaults: {
    favicon: { file: string; type: string };
    socialImage: string;
    /** Generated OG cards: their paths and fixed size. */
    ogCard: {
      sitePath: string;
      pagePrefix: string;
      size: { width: number; height: number };
    };
    /** Sizes of social images measured in `public/`, by logical path. */
    imageSizes: Record<string, { width: number; height: number }>;
  };
  /**
   * The file whose edits change the page-collection list. In dev an edit
   * re-runs every loader (Astro clears the store), so the virtual module is
   * invalidated to re-read the record.
   */
  contentConfigPath?: string;
}

function runtimeSources(sources: NimbusConfig["sources"]): RuntimeNimbusConfig["sources"] {
  const out: Record<string, RuntimeContentSource> = {};
  for (const [name, source] of Object.entries(sources ?? {})) {
    if (source.editPattern) out[name] = { ref: source.ref, editPattern: source.editPattern };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function virtualConfigPlugin(
  config: NimbusConfig,
  extras: VirtualConfigExtras,
): VitePluginLike {
  const runtimeConfig: RuntimeNimbusConfig = {
    ...config,
    // The page bundle gets only what `getEditUrl` reads of a source: its
    // configured `ref` and `editPattern`, never `repo` or `path`.
    sources: runtimeSources(config.sources),
    ...(config.api
      ? {
          api: config.api.map((entry) =>
            entry.versions
              ? {
                  ...entry,
                  versions: entry.versions.map((version) => ({
                    ...version,
                    spec: {},
                  })),
                }
              : { ...entry, spec: {} },
          ),
        }
      : {}),
  };
  return {
    name: "nimbus-docs:virtual-config",
    resolveId(id: string) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return undefined;
    },
    async load(id: string) {
      if (id === RESOLVED_ID) {
        const indexedCollections = await extras.getIndexedCollections();
        const emptyCollections = (await extras.getEmptyCollections?.()) ?? [];
        const buildSlice = (await extras.getBuildSlice?.()) ?? null;
        const primaryCollectionAbsent = (await extras.getPrimaryCollectionAbsent?.()) ?? false;
        return (
          `export const config = ${JSON.stringify(runtimeConfig)};\n` +
          `export const pageAssets = ${JSON.stringify(extras.getPageAssets?.() ?? {})};\n` +
          `export const navLists = ${JSON.stringify(extras.getNavLists?.() ?? {})};\n` +
          `export const apiLists = ${JSON.stringify(extras.getApiLists?.() ?? {})};\n` +
          `export const indexedCollections = ${JSON.stringify(indexedCollections)};\n` +
          `export const emptyCollections = ${JSON.stringify(emptyCollections)};\n` +
          `export const primaryCollectionAbsent = ${JSON.stringify(primaryCollectionAbsent)};\n` +
          `export const buildSlice = ${JSON.stringify(buildSlice)};\n` +
          `export const searchIndex = ${JSON.stringify(buildSlice?.search ?? searchIndexLayout(null, [], { versions: null, routes: NO_ROUTES }, extras.base))};\n` +
          `export const requestRenderingCollections = ${JSON.stringify(extras.requestRenderingCollections)};\n` +
          `export const versionAlternates = ${JSON.stringify(extras.versionAlternates)};\n` +
          `export const apiCollections = ${JSON.stringify(extras.apiCollections)};\n` +
          `export const collectionRoutes = ${JSON.stringify([...extras.collectionRoutes])};\n` +
          `export const unreadCollectionRoutes = ${JSON.stringify(extras.unreadCollectionRoutes)};\n` +
          `export const nestedLlmsSections = ${JSON.stringify(extras.getNestedLlmsSections?.() ?? false)};\n` +
          `export const headDefaults = ${JSON.stringify(extras.headDefaults)};\n`
        );
      }
      return undefined;
    },
    handleHotUpdate({ file, server }) {
      const target = extras.contentConfigPath?.replaceAll("\\", "/");
      if (!target || file.replaceAll("\\", "/") !== target) {
        return;
      }
      // Reload the runners that render pages, as Astro does for a server-only
      // module: `runtime-config.ts` caches the collection list in module
      // state. Astro's own reload skips this module, which the browser loads
      // too.
      refreshDevRunners(server);
    },
  };
}
