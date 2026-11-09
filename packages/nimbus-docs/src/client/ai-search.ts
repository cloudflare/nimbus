/**
 * The browser transport for a Cloudflare AI Search instance's public
 * `/search` endpoint, and the normaliser that turns its chunks into
 * documentation-search sections. The search dialog's `ai-search` provider
 * and browser WebMCP both use it, so filters, limits and errors match.
 */
import { SEARCH_LIMITS, type DocumentationSection } from "../_internal/agent-search-contract.js";
import type { PageSearchScope, SearchErrorCode } from "../types.js";

export interface AiSearchClientOptions {
  /** The instance's public endpoint origin. */
  endpoint: string;
  /** The site's origin and base: result URLs outside them are dropped. */
  site: string;
  base?: string;
}

export type AiSearchFilters = Record<string, string | boolean | { $in: string[] }>;

export type AiSearchResponse =
  | { results: DocumentationSection[] }
  | { error: { code: SearchErrorCode; message: string } };

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

const MESSAGES = {
  busy: "Search is busy. Try again in a moment.",
  network:
    "Search couldn't reach the search service. Check your connection; if it persists, the site's search endpoint may not allow this address.",
  failed: "Search failed. Try again in a moment.",
  invalid: "Type a query of at most 500 characters.",
} as const;

/**
 * The filters for a search from a page. Readers search every visible version
 * that isn't deprecated; a reader on a deprecated version's page searches
 * that version alone. A scope policy, not access control: the endpoint is
 * public.
 */
export function aiSearchFilters(
  scope: PageSearchScope | undefined,
  choice?: { versions?: readonly string[] },
): AiSearchFilters {
  const filters: AiSearchFilters = {};
  if (choice?.versions) filters.version = { $in: [...choice.versions] };
  else if (scope?.deprecated) filters.version = scope.version;
  else filters.deprecated = false;
  return filters;
}

function failure(code: SearchErrorCode, message: string): AiSearchResponse {
  return { error: { code, message } };
}

/** One search. Never retries; the caller's signal cancels it. */
export async function searchAiSearch(
  options: AiSearchClientOptions,
  query: string,
  request: { filters: AiSearchFilters; limit?: number; signal?: AbortSignal },
): Promise<AiSearchResponse> {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > SEARCH_LIMITS.query) return failure("invalid_input", MESSAGES.invalid);
  const limit = Math.min(Math.max(request.limit ?? SEARCH_LIMITS.maxLimit, 1), 50);
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(new URL("/search", options.endpoint), {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: trimmed,
          ai_search_options: {
            retrieval: {
              retrieval_type: "hybrid",
              // Several chunks a page: the results are deduplicated by page.
              max_num_results: Math.min(limit * 2, 50),
              filters: request.filters,
              return_on_failure: false,
            },
          },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (request.signal?.aborted) throw error;
      return failure("search_failed", controller.signal.aborted ? MESSAGES.failed : MESSAGES.network);
    }
    if (response.status === 429) return failure("search_failed", MESSAGES.busy);
    if (!response.ok) return failure("search_failed", MESSAGES.failed);
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) return failure("search_failed", MESSAGES.failed);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return failure("search_failed", MESSAGES.failed);
    }
    const results = normaliseAiSearchChunks(body, options);
    return results ? { results: results.slice(0, limit) } : failure("search_failed", MESSAGES.failed);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", abort);
  }
}

interface Chunk {
  text?: unknown;
  item?: { metadata?: Record<string, unknown> };
}

/**
 * Chunks to sections, one per page in rank order. A chunk whose `url` isn't
 * a page of this site (another origin, outside the base, credentials) is
 * dropped; kept URLs become paths, so dev and preview origins link to
 * themselves. `undefined` when the body isn't a search response.
 */
export function normaliseAiSearchChunks(
  body: unknown,
  options: Pick<AiSearchClientOptions, "site" | "base">,
): DocumentationSection[] | undefined {
  const root = body as { result?: { chunks?: unknown }; chunks?: unknown } | null;
  const chunks = root?.result?.chunks ?? root?.chunks;
  if (!Array.isArray(chunks)) return undefined;
  const site = new URL(options.site);
  const base = `/${(options.base ?? "/").split("/").filter(Boolean).join("/")}`;
  const seen = new Set<string>();
  const sections: DocumentationSection[] = [];
  for (const chunk of chunks as Chunk[]) {
    const metadata = chunk?.item?.metadata;
    if (!metadata || typeof metadata.url !== "string" || typeof chunk.text !== "string") continue;
    let url: URL;
    try {
      url = new URL(metadata.url);
    } catch {
      continue;
    }
    if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.origin !== site.origin) continue;
    if (base !== "/" && url.pathname !== base && !url.pathname.startsWith(`${base}/`)) continue;
    const path = url.pathname;
    if (seen.has(path)) continue;
    seen.add(path);
    const title = typeof metadata.title === "string" && metadata.title.trim() ? metadata.title.trim() : path;
    const heading = firstHeading(chunk.text);
    sections.push({
      title,
      heading: heading === title ? "" : heading,
      url: path,
      excerpt: plainExcerpt(chunk.text),
    });
  }
  return sections;
}

/** The text of the first ATX heading (`## Title ##`), without regexes that backtrack. */
function firstHeading(markdown: string): string {
  for (const line of markdown.split("\n")) {
    let level = 0;
    while (level < line.length && line[level] === "#") level += 1;
    if (level < 1 || level > 6 || (line[level] !== " " && line[level] !== "\t")) continue;
    const text = line.slice(level).trim();
    let end = text.length;
    while (end > 0 && text[end - 1] === "#") end -= 1;
    return text.slice(0, end).trim();
  }
  return "";
}

/** Markdown to a short plain line: no headings, emphasis, link targets or code fences. */
function plainExcerpt(markdown: string): string {
  const text = markdown
    .replace(/```[\s\S]*?(```|$)/gu, " ")
    .replace(/^#{1,6}\s+.*$/gmu, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/^\s*>\s?/gmu, "")
    .replace(/(\*\*?)(\S(?:.*?\S)?)\1/gu, "$2")
    .replace(/`/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > SEARCH_LIMITS.excerpt ? `${text.slice(0, SEARCH_LIMITS.excerpt - 1)}…` : text;
}
