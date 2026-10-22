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
 * Default Pagefind filters applied to every search.
 *
 * Versioning: when the site has a `versions.deprecated` list, the
 * layout emits `data-pagefind-filter="status:deprecated"` on every
 * deprecated-version page. Search defaults to current and non-deprecated
 * results.
 *
 * Versions are still searchable individually — readers on a v0 page
 * who explicitly search from there can opt the UI into a version-scoped
 * filter. The default exclusion is just for the top-level search.
 *
 * Computed at module-import time so we don't pay the config lookup on
 * every keystroke.
 */
const defaultFilters: PagefindFilters | undefined =
  config.versions && config.versions.deprecated && config.versions.deprecated.length > 0
    ? { status: { none: "deprecated" } }
    : undefined;

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

    const search = await pagefind.search(
      query,
      defaultFilters ? { filters: defaultFilters } : undefined,
    );
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
