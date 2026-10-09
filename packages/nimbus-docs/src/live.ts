/**
 * Astro live loader for API references with `bundle: false`.
 *
 * Astro reads live collections only from the site's `src/live.config.ts`:
 *
 *   // src/live.config.ts
 *   import { defineLiveCollection } from "astro:content";
 *   import { apiPagesLoader } from "@cloudflare/nimbus-docs/live";
 *
 *   export const collections = {
 *     apiPages: defineLiveCollection({ loader: apiPagesLoader() }),
 *   };
 *
 * Nimbus's API routes read each page through `getLiveEntry("apiPages", …)`.
 * Entries carry cache tags per API and version for Astro's route cache.
 */
import type { LiveLoader } from "astro/loaders";
import type { ApiNav, ApiPageProps } from "./_internal/api/api-view-types.js";

/** The live collection name Nimbus's routes read. */
export const API_PAGES_COLLECTION = "apiPages";

export interface ApiPageEntry {
  page: ApiPageProps;
  nav: ApiNav;
}

export interface ApiPageFilter {
  collection: string;
  version: string | null;
  /** The page's coordinate. */
  id: string;
  /** The incoming request, for reading build output from the same origin.
   * Astro 7 passes filters to the loader unchanged; it doesn't key on them. */
  request?: Request;
}

/** What a site's `src/live.config.ts` needs, printed by build and runtime errors. */
export const liveConfigSnippet =
  'import { defineLiveCollection } from "astro:content";\n' +
  'import { apiPagesLoader } from "@cloudflare/nimbus-docs/live";\n\n' +
  "export const collections = {\n" +
  "  apiPages: defineLiveCollection({ loader: apiPagesLoader() }),\n" +
  "};\n";

export function apiPagesLoader(): LiveLoader<ApiPageEntry, ApiPageFilter> {
  return {
    name: "@cloudflare/nimbus-docs/api-pages",
    async loadEntry({ filter }) {
      const { getApiAssetPage, hasApiPageAssets } =
        await import("./_internal/api/page-assets-runtime.js");
      if (!(await hasApiPageAssets(filter.collection))) return undefined;
      try {
        const data = await getApiAssetPage(
          filter.collection,
          filter.version,
          filter.id,
          filter.request,
        );
        return {
          id: `${filter.collection}@${filter.version ?? ""}:${filter.id}`,
          data,
          cacheHint: {
            tags: [
              `nimbus-api:${filter.collection}`,
              `nimbus-api:${filter.collection}@${filter.version ?? ""}`,
            ],
          },
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    },
    async loadCollection() {
      return {
        error: new Error(
          "nimbus-docs: the apiPages live collection loads one page at a time; use getLiveEntry.",
        ),
      };
    },
  };
}
