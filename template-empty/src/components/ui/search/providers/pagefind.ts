import { mergeSearchIndexes } from "@cloudflare/nimbus-docs/client";
import type { SearchProvider, SearchResult } from "@cloudflare/nimbus-docs/types";
import { config, searchIndex } from "virtual:nimbus/config";

interface PagefindSubResult {
  title?: string;
  url?: string;
}

interface PagefindResultData {
  url: string;
  excerpt?: string;
  meta?: { title?: string };
  sub_results?: PagefindSubResult[];
}

interface PagefindSearchResponse {
  results: Array<{ data(): Promise<PagefindResultData> }>;
}

interface PagefindFilters {
  [key: string]: string | string[] | { none?: string | string[]; any?: string | string[] };
}

interface PagefindApi {
  init(): Promise<void>;
  options(options: { baseUrl?: string }): Promise<void>;
  mergeIndex(indexPath: string, options?: { baseUrl?: string }): Promise<void>;
  search(query: string, options?: { filters?: PagefindFilters }): Promise<PagefindSearchResponse>;
}

let pagefind: PagefindApi | undefined;

/**
 * Search leaves out deprecated versions when the site has any: the layouts
 * mark a deprecated-version page with `data-pagefind-filter="status:deprecated"`.
 */
const excludeDeprecated: PagefindFilters | undefined =
  config.versions && config.versions.deprecated && config.versions.deprecated.length > 0
    ? { status: { none: "deprecated" } }
    : undefined;

/**
 * The filters for a search from the current page, read on every search since
 * this module outlives client-side navigation. A reader on a deprecated
 * version's page searches that version: the layouts mark its version with
 * `data-pagefind-filter="version:<v>"`. Anywhere else, deprecated versions are
 * left out. A page marked deprecated without a version (a later part of an API
 * home) falls back to that too.
 */
function filtersForPage(): PagefindFilters | undefined {
  const deprecated = document.querySelector('[data-pagefind-filter="status:deprecated"]');
  const version = document
    .querySelector('[data-pagefind-filter^="version:"]')
    ?.getAttribute("data-pagefind-filter")
    ?.slice("version:".length);
  if (deprecated && version) return { version };
  return excludeDeprecated;
}

export const provider: SearchProvider = {
  async init() {
    if (pagefind) return;
    // `searchIndex.bundle` is the site's bundle (`/pagefind/`, under the
    // base when there is one); a site built in slices (`NIMBUS_BUILD_ONLY`)
    // keeps each slice's bundle under its prefix, and `merge` names the other
    // slices' bundles, so one search box still covers the site. Both are
    // served URLs, base included.
    const pagefindUrl = new URL(`${searchIndex.bundle}pagefind.js`, window.location.origin);
    const loaded = (await import(/* @vite-ignore */ pagefindUrl.href)) as PagefindApi;
    // Every index is built from the output root, so result URLs already carry
    // their prefix and need only the base, which Pagefind adds to each one.
    const baseUrl = `${(import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "")}/`;
    await loaded.options({ baseUrl });
    await loaded.init();
    // A slice that holds several collections writes one bundle; the other
    // collections' URLs answer 404 and are skipped.
    await mergeSearchIndexes(loaded, searchIndex.merge, { baseUrl });
    pagefind = loaded;
  },

  async search(query) {
    if (!pagefind) await this.init?.();
    if (!pagefind) return [];

    const filters = filtersForPage();
    const search = await pagefind.search(query, filters ? { filters } : undefined);
    const results = await Promise.all(search.results.slice(0, 10).map((result) => result.data()));
    return results.map((result): SearchResult => ({
      title: result.meta?.title ?? "Untitled",
      url: result.url,
      snippet: result.excerpt,
      subResults: result.sub_results
        ?.filter((sub): sub is Required<PagefindSubResult> => Boolean(sub.title && sub.url))
        .map((sub) => ({ title: sub.title, url: sub.url })),
    }));
  },
};
