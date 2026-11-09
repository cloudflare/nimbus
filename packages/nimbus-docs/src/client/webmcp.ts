import {
  documentationSearchTool,
  PagefindCompatibilityError,
  parseSearchInput,
  searchFailure,
} from "../_internal/agent-search-contract.js";
import type {
  DocumentationPagefind,
  DocumentationSearchOptions,
} from "../_internal/agent-search-contract.js";
import { mergeSearchIndexes, type MergeablePagefind } from "./search-indexes.js";

export interface DocumentationWebMcpOptions extends DocumentationSearchOptions {
  title: string;
  search: "pagefind" | "ai-search" | "unavailable";
  /** `ai-search`: the instance's public endpoint origin. */
  endpoint?: string;
  /** `ai-search`: each version label and the version pair hashes it selects. */
  versionChoices?: Record<string, readonly string[]>;
  /**
   * The Pagefind bundle to search and the other slices' bundles to merge into
   * it, as `searchIndex` in `virtual:nimbus/config` names them. Without
   * `bundle`, the site's `/pagefind/` under `base`.
   */
  bundle?: string;
  merge?: readonly string[];
}

interface PagefindInstance extends DocumentationPagefind, MergeablePagefind {
  init(): Promise<unknown>;
  filters(): Promise<unknown>;
  destroy(): Promise<unknown>;
}
interface PagefindModule {
  createInstance(options: {
    basePath: string;
    baseUrl: string;
  }): PagefindInstance;
}
export interface DocumentationModelContext {
  registerTool(
    tool: {
      name: string;
      description: string;
      inputSchema: object;
      annotations: { readOnlyHint: true; untrustedContentHint: true };
      execute(
        input: unknown,
        options: { signal: AbortSignal },
      ): Promise<unknown>;
    },
    options: { signal: AbortSignal },
  ): Promise<unknown>;
}

const compatibilityWarnings = new WeakSet<DocumentationModelContext>();
const registrations = new WeakMap<DocumentationModelContext, AbortController>();

/** @internal Loader seam used by the browser conformance tests. */
export function registerDocumentationWebMcp(
  context: DocumentationModelContext,
  options: DocumentationWebMcpOptions,
  importPagefind: () => Promise<PagefindModule>,
): () => void {
  if (options.search !== "pagefind" || registrations.has(context))
    return () => {};
  const lifetime = new AbortController();
  registrations.set(context, lifetime);
  let loading: Promise<PagefindInstance> | undefined;
  let instance: PagefindInstance | undefined;
  const base = `/${(options.base ?? "/").split("/").filter(Boolean).join("/")}`;
  const baseUrl = base === "/" ? "/" : `${base}/`;

  const resetIndex = async () => {
    loading = undefined;
    const current = instance;
    instance = undefined;
    if (current) await current.destroy().catch(() => {});
  };
  const destroy = () => {
    lifetime.abort();
    if (registrations.get(context) === lifetime) registrations.delete(context);
    void resetIndex();
  };

  const load = () =>
    (loading ??= (async () => {
      let candidate: PagefindInstance | undefined;
      try {
        lifetime.signal.throwIfAborted();
        const module = await importPagefind();
        lifetime.signal.throwIfAborted();
        if (typeof module.createInstance !== "function") {
          const error = new PagefindCompatibilityError();
          if (!compatibilityWarnings.has(context)) {
            compatibilityWarnings.add(context);
            console.warn(`nimbus-docs: ${error.message}`);
          }
          throw error;
        }
        candidate = module.createInstance({
          basePath: options.bundle ?? `${baseUrl}pagefind/`,
          baseUrl,
        });
        instance = candidate;
        await candidate.init();
        // The other slices' bundles, as the search dialog merges them.
        if (options.merge?.length) await mergeSearchIndexes(candidate, options.merge, { baseUrl });
        // init() may only initialize the worker wrapper. filters() also waits for
        // the index/WASM, so an absent previous build is index_unavailable.
        await candidate.filters();
        lifetime.signal.throwIfAborted();
        return candidate;
      } catch (error) {
        if (candidate && instance === candidate) {
          instance = undefined;
          await candidate.destroy().catch(() => {});
        }
        loading = undefined;
        throw error;
      }
    })());

  // Registration needs only the small contract. The parser/search implementation
  // is fetched once the tool is actually called, never just to expose its schema.
  let search:
    | Promise<
        ReturnType<
          (typeof import("../_internal/agent-search.js"))["createDocumentationSearch"]
        >
      >
    | undefined;
  void Promise.resolve()
    .then(() => {
      if (lifetime.signal.aborted) return;
      return context.registerTool(
        {
          ...documentationSearchTool(options.title, options.versions),
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          async execute(input, execution) {
            lifetime.signal.throwIfAborted();
            execution.signal.throwIfAborted();
            search ??= import("../_internal/agent-search.js")
              .then(({ createDocumentationSearch }) =>
                createDocumentationSearch(load, options, resetIndex),
              )
              .catch((error) => {
                search = undefined;
                throw error;
              });
            const run = await search.catch(() => undefined);
            lifetime.signal.throwIfAborted();
            execution.signal.throwIfAborted();
            if (!run)
              return searchFailure(
                "search_failed",
                "Documentation search code could not be loaded. Check your connection and reload the page.",
              );
            const result = await run(input, execution.signal);
            lifetime.signal.throwIfAborted();
            execution.signal.throwIfAborted();
            return result;
          },
        },
        { signal: lifetime.signal },
      );
    })
    .catch(destroy);
  return destroy;
}

/**
 * @internal The `ai-search` tool: the dialog's transport and filters, with
 * the label a caller picks mapped to its version pairs. Its code loads when
 * the tool is first called.
 */
export function registerAiSearchWebMcp(
  context: DocumentationModelContext,
  options: DocumentationWebMcpOptions,
): () => void {
  if (options.search !== "ai-search" || !options.endpoint || registrations.has(context)) return () => {};
  const lifetime = new AbortController();
  registrations.set(context, lifetime);
  const destroy = () => {
    lifetime.abort();
    if (registrations.get(context) === lifetime) registrations.delete(context);
  };
  const endpoint = options.endpoint;
  void Promise.resolve()
    .then(() => {
      if (lifetime.signal.aborted) return;
      return context.registerTool(
        {
          ...documentationSearchTool(options.title, options.versions),
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          async execute(input, execution) {
            lifetime.signal.throwIfAborted();
            execution.signal.throwIfAborted();
            const parsed = parseSearchInput(input, options.versions);
            if (!parsed) return searchFailure("invalid_input");
            const client = await import("./ai-search.js").catch(() => undefined);
            if (!client)
              return searchFailure(
                "search_failed",
                "Documentation search code could not be loaded. Check your connection and reload the page.",
              );
            const versions = parsed.version !== undefined ? options.versionChoices?.[parsed.version] ?? [] : undefined;
            const response = await client.searchAiSearch(
              { endpoint, site: options.site, base: options.base },
              parsed.query,
              {
                filters: client.aiSearchFilters(undefined, versions ? { versions } : undefined),
                limit: parsed.limit,
                signal: execution.signal,
              },
            );
            execution.signal.throwIfAborted();
            if ("error" in response) return response;
            return {
              results: response.results.map((result) => ({ ...result, url: new URL(result.url, options.site).href })),
            };
          },
        },
        { signal: lifetime.signal },
      );
    })
    .catch(destroy);
  return destroy;
}

/** Current WebMCP draft (2026-10-02): Document.modelContext + registration signal. */
export function initDocumentationWebMcp(
  options: DocumentationWebMcpOptions,
): () => void {
  if ((options.search !== "pagefind" && options.search !== "ai-search") || typeof document === "undefined")
    return () => {};
  let context: DocumentationModelContext | undefined;
  try {
    context = (
      document as Document & { modelContext?: DocumentationModelContext }
    ).modelContext;
  } catch {
    return () => {};
  }
  if (!context || typeof context.registerTool !== "function") return () => {};
  if (options.search === "ai-search") return registerAiSearchWebMcp(context, options);
  const base = `/${(options.base ?? "/").split("/").filter(Boolean).join("/")}`;
  const moduleUrl = new URL(
    options.bundle ? `${options.bundle}pagefind.js` : `${base === "/" ? "" : base}/pagefind/pagefind.js`,
    location.origin,
  ).href;
  return registerDocumentationWebMcp(
    context,
    options,
    () => import(/* @vite-ignore */ moduleUrl),
  );
}
