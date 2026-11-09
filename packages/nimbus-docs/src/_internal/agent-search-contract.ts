export const SEARCH_LIMITS = {
  query: 500,
  defaultLimit: 5,
  maxLimit: 20,
  excerpt: 1000,
} as const;
export type SearchErrorCode =
  "invalid_input" | "index_unavailable" | "search_failed";
export interface DocumentationSection {
  title: string;
  heading: string;
  url: string;
  excerpt: string;
}
export type DocumentationSearchResponse =
  | { results: DocumentationSection[] }
  | { error: { code: SearchErrorCode; message: string } };
/** The initialized Pagefind API used by documentation search. */
export interface DocumentationPagefind {
  search(
    query: string,
    options: { filters?: Record<string, string | { none: string[] }> },
  ): Promise<{
    results: {
      data(): Promise<{
        url: string;
        meta: { title?: string };
        excerpt: string;
        sub_results?: { title: string; url: string; excerpt: string }[];
      }>;
    }[];
  }>;
}
export interface DocumentationSearchOptions {
  site: string;
  base?: string;
  /** Visible versions only; deprecated versions remain valid explicit targets. */
  versions?: readonly string[];
}

export function documentationSearchTool(
  siteName: string,
  versions: readonly string[] = [],
) {
  return {
    name: "search_documentation" as const,
    description: `Search the ${siteName} documentation for relevant sections.`,
    inputSchema: {
      type: "object" as const,
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: SEARCH_LIMITS.query,
          pattern: "\\S",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: SEARCH_LIMITS.maxLimit,
          default: SEARCH_LIMITS.defaultLimit,
        },
        ...(versions.length
          ? { version: { type: "string", enum: [...versions] } }
          : {}),
      },
    },
  };
}

/** A known incompatibility, distinct from missing assets and opaque loader failures. */
export class PagefindCompatibilityError extends Error {
  constructor() {
    super(
      "Documentation search requires Pagefind 1.5.2 or newer. Ask the site owner to upgrade Pagefind and rebuild the site.",
    );
    this.name = "PagefindCompatibilityError";
  }
}

export function searchFailure(
  code: SearchErrorCode,
  message?: string,
): DocumentationSearchResponse {
  const messages = {
    invalid_input:
      "Provide a non-empty query of at most 500 characters, a limit from 1 to 20, and a visible version if supported.",
    index_unavailable:
      "Documentation search index could not be loaded. Check your connection and reload the page. If it persists, ask the site owner to rebuild and deploy the search index.",
    search_failed:
      "Documentation search failed. Retry the search; if it still fails, check your connection and reload the page.",
  };
  return { error: { code, message: message ?? messages[code] } };
}

/** The tool's input, checked as every backend checks it; `undefined` when invalid. */
export function parseSearchInput(
  input: unknown,
  versions: readonly string[] | undefined,
): { query: string; limit: number; version?: string } | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const { query, limit = SEARCH_LIMITS.defaultLimit, version } = record;
  if (
    Object.keys(record).some((key) => !["query", "limit", "version"].includes(key)) ||
    typeof query !== "string" ||
    query.length > SEARCH_LIMITS.query * 2 ||
    !query.trim() ||
    [...query].length > SEARCH_LIMITS.query ||
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > SEARCH_LIMITS.maxLimit ||
    (version !== undefined && (typeof version !== "string" || !versions?.includes(version)))
  )
    return undefined;
  return { query: query.trim(), limit, ...(version !== undefined ? { version: version as string } : {}) };
}
