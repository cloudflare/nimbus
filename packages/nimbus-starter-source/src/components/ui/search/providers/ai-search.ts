import { pageSearchScope } from "@cloudflare/nimbus-docs/client";
import { aiSearchFilters, searchAiSearch } from "@cloudflare/nimbus-docs/client/ai-search";
import type { SearchProvider, SearchResponse, SearchResult } from "@cloudflare/nimbus-docs/types";
import { config } from "virtual:nimbus/config";

/**
 * Search a Cloudflare AI Search instance's public endpoint, filled by
 * `nimbus-docs search sync`. A query leaves out deprecated versions, except
 * from a deprecated version's page, which searches that version.
 */
const search = config.search && config.search.provider === "ai-search" ? config.search : undefined;

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// The same query from the same scope answers from the last response.
let last: { key: string; response: SearchResponse } | undefined;

export const provider: SearchProvider<SearchResponse> = {
  options: { wait: search?.wait, minQueryLength: search?.minQueryLength },

  async search(query, { signal } = {}) {
    if (!search) {
      return { error: { code: "index_unavailable", message: 'Set search: { provider: "ai-search" } in astro.config to use this provider.' } };
    }
    const filters = aiSearchFilters(pageSearchScope());
    const key = JSON.stringify([query, filters]);
    if (last?.key === key) return last.response;

    const found = await searchAiSearch(
      { endpoint: search.endpoint, site: config.site, base: import.meta.env.BASE_URL },
      query,
      { filters, limit: 10, signal },
    );
    if ("error" in found) return found;
    const response: SearchResponse = {
      results: found.results.map((result): SearchResult => ({
        title: result.title,
        url: result.url,
        snippet: escape(
          [result.heading, result.excerpt.length > 180 ? `${result.excerpt.slice(0, 179)}…` : result.excerpt]
            .filter(Boolean)
            .join(" — "),
        ),
      })),
    };
    last = { key, response };
    return response;
  },
};
