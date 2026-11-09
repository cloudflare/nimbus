import {
  SEARCH_LIMITS,
  PagefindCompatibilityError,
  parseSearchInput,
  searchFailure as failure,
} from "./agent-search-contract.js";
import type {
  DocumentationSearchResponse,
  DocumentationSearchOptions,
  DocumentationPagefind,
  DocumentationSection,
} from "./agent-search-contract.js";

/**
 * Pagefind builds excerpts by escaping only `<` and `>` in the page text and
 * then wrapping matched words in `<mark>`. Reverse exactly that, so literal
 * entities in the documentation (such as `&amp;` in a code sample) survive and
 * the browser and other runtimes agree. No HTML parser, no injection sink.
 */
function plainText(excerpt: string): string {
  return excerpt
    .replace(/<\/?mark>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Pagefind URLs may already include Astro's base. Never add it twice. */
function sectionUrl(
  value: string,
  options: DocumentationSearchOptions,
): string {
  const site = new URL(options.site);
  const base = `/${(options.base ?? "/").split("/").filter(Boolean).join("/")}`;
  const url = new URL(
    value,
    `${site.origin}${base === "/" ? "/" : `${base}/`}`,
  );
  if (
    url.origin !== site.origin ||
    !["http:", "https:"].includes(url.protocol)
  ) {
    throw new Error("Pagefind returned an off-site URL");
  }
  if (
    base !== "/" &&
    url.pathname !== base &&
    !url.pathname.startsWith(`${base}/`)
  ) {
    url.pathname = base + url.pathname;
  }
  // A page-level match is the page itself; a bare `#` would read as a section.
  return url.href;
}

/** Load the existing build's Pagefind index; this function never builds an index. */
export function createDocumentationSearch(
  loadIndex: () => Promise<DocumentationPagefind>,
  options: DocumentationSearchOptions,
  resetIndex?: () => Promise<void>,
): (
  input: unknown,
  signal?: AbortSignal,
) => Promise<DocumentationSearchResponse> {
  const run = async (
    input: unknown,
    signal?: AbortSignal,
  ): Promise<DocumentationSearchResponse> => {
    const parsed = parseSearchInput(input, options.versions);
    if (!parsed) return failure("invalid_input");
    const { query, limit, version } = parsed;
    let index: DocumentationPagefind;
    try {
      index = await loadIndex();
    } catch (error) {
      return failure(
        "index_unavailable",
        error instanceof PagefindCompatibilityError ? error.message : undefined,
      );
    }
    try {
      const filters: Record<string, string | { none: string[] }> =
        version === undefined
          ? { status: { none: ["deprecated"] } }
          : { version: version as string };
      const found = await index.search(query.trim(), { filters });
      const results: DocumentationSection[] = [];
      const seen = new Set<string>();
      // Load lazily and stop as soon as the section limit is met.
      for (const match of found.results.slice(0, SEARCH_LIMITS.maxLimit * 4)) {
        signal?.throwIfAborted();
        const page = await match.data();
        const title = page.meta.title ?? "";
        const sections = page.sub_results?.length
          ? page.sub_results
          : [{ title, url: page.url, excerpt: page.excerpt }];
        for (const section of sections) {
          const url = sectionUrl(section.url, options);
          if (seen.has(url)) continue;
          seen.add(url);
          results.push({
            title,
            heading: section.title,
            url,
            excerpt: [...plainText(section.excerpt)]
              .slice(0, SEARCH_LIMITS.excerpt)
              .join(""),
          });
          if (results.length === limit) return { results };
        }
      }
      return { results };
    } catch (error) {
      if (!signal?.aborted || error !== signal.reason) await resetIndex?.();
      signal?.throwIfAborted();
      return failure("search_failed");
    }
  };
  // Pagefind mutates cached fragments while constructing query-specific excerpts.
  // Keep search + data hydration atomic relative to other calls on this instance.
  // A call cancelled while queued never runs; one cancelled mid-flight stops
  // hydrating and rejects. Cancellation alone keeps the shared index intact.
  let pending: Promise<unknown> = Promise.resolve();
  return (input, signal) => {
    const response = pending.then(() => {
      signal?.throwIfAborted();
      return run(input, signal);
    });
    pending = response.catch(() => undefined);
    return response;
  };
}
