import type { APIContext, APIRoute, GetStaticPaths } from "astro";
import { entryRouteKey } from "./_internal/astro-slug.js";
import type {
  LlmsEndpointAsset,
  MarkdownEndpointAsset,
} from "./_internal/agent-endpoint-assets.js";
import { readStagedAsset } from "./_internal/staged-asset-reader.js";
import {
  findOwnMarkdownRoute,
  higherMarkdownRouteOwner,
  routeParams,
} from "./_internal/markdown-routes.js";
export type MarkdownEndpointSurface = "markdown" | "source";

export interface MarkdownEndpointReference {
  collection: string;
  id: string;
  surface: MarkdownEndpointSurface;
}

export interface MarkdownEndpointPayload extends MarkdownEndpointReference {
  digest: string;
  mediaType: string;
  body: string;
  content: string;
}

export type LlmsEndpointReference =
  | { scope: "site"; surface: "index" }
  | { scope: "section"; surface: "index"; section: string };

export type LlmsEndpointPayload = LlmsEndpointReference & {
  digest: string;
  mediaType: string;
  body: string;
};

let agentEndpointAssetsModule: Promise<
  typeof import("virtual:nimbus/agent-endpoint-assets")
> | null = null;
let markdownByIdentity:
  | Map<string, MarkdownEndpointAsset>
  | undefined;
let markdownByRoute: Map<string, MarkdownEndpointAsset> | undefined;
let markdownByUrl: Map<string, MarkdownEndpointAsset> | undefined;
let llmsByIdentity: Map<string, LlmsEndpointAsset> | undefined;

interface AgentEndpointContext {
  request?: Request;
}

function loadAgentEndpointAssets() {
  agentEndpointAssetsModule ??= import("virtual:nimbus/agent-endpoint-assets");
  return agentEndpointAssetsModule;
}

function markdownIdentity(reference: MarkdownEndpointReference): string {
  return `${reference.collection}\0${reference.id}\0${reference.surface}`;
}

function markdownRouteIdentity(options: {
  collection: string;
  surface: MarkdownEndpointSurface;
  slug?: string;
}): string {
  return `${options.collection}\0${options.surface}\0${options.slug ?? ""}`;
}

function llmsIdentity(reference: LlmsEndpointReference): string {
  return reference.scope === "site"
    ? `${reference.scope}\0${reference.surface}`
    : `${reference.scope}\0${reference.section}\0${reference.surface}`;
}

async function readAssetBody(
  assetPath: string,
  context: AgentEndpointContext,
): Promise<string> {
  return readStagedAsset(`_nimbus/agent-endpoint-assets/${assetPath}`, context);
}

async function selectedApiOutputIsDefault(
  collection: string,
  request?: Request,
): Promise<boolean> {
  if (!request) return true;
  const params = new URL(request.url).searchParams;
  if (!params.has("api-version")) return true;
  const { hasApiPageAssets } =
    await import("./_internal/api/page-assets-runtime.js");
  if (!(await hasApiPageAssets(collection))) return true;
  const { loadNimbusConfig } = await import("./_internal/runtime-config.js");
  const api = (await loadNimbusConfig()).api?.find(
    (entry) => entry.collection === collection,
  );
  const versions = api?.versions;
  // An unversioned API has only its default output.
  if (!versions?.length) return true;
  const { selectApiVersion } =
    await import("./_internal/api/resolve-versions.js");
  const defaultVersion = (versions.find((entry) => entry.default) ??
    versions[0])!.version;
  return (
    selectApiVersion(params, {
      defaultVersion,
      versions: new Set(versions.map((entry) => entry.version)),
    }) === defaultVersion
  );
}

async function markdownIndexes() {
  const { markdownAssets } = await loadAgentEndpointAssets();
  if (!markdownByIdentity || !markdownByRoute || !markdownByUrl) {
    markdownByIdentity = new Map();
    markdownByRoute = new Map();
    markdownByUrl = new Map();
    for (const asset of markdownAssets) {
      markdownByIdentity.set(markdownIdentity(asset), asset);
      markdownByUrl.set(asset.url, asset);
      markdownByRoute.set(
        markdownRouteIdentity({
          collection: asset.collection,
          surface: asset.surface,
          slug: entryRouteKey(asset.id),
        }),
        asset,
      );
    }
  }
  return { markdownAssets, markdownByIdentity, markdownByRoute, markdownByUrl };
}

async function llmsIndex() {
  const { llmsAssets } = await loadAgentEndpointAssets();
  if (!llmsByIdentity) {
    llmsByIdentity = new Map(
      llmsAssets.map((asset) => [llmsIdentity(asset), asset]),
    );
  }
  return { llmsAssets, llmsByIdentity };
}

/**
 * Static paths for one collection's Markdown or source assets, keyed by
 * collection-relative slug. API collections have `markdown` assets too, so
 * `getMarkdownStaticPaths({ collection: "<api>", surface: "markdown" })`
 * returns one entry per API page (hidden API versions excluded). Prefer
 * {@link markdownRoute} for a route that serves every collection.
 */
export async function getMarkdownStaticPaths(options: {
  collection: string;
  surface: MarkdownEndpointSurface;
}): Promise<
  Array<{
    params: { slug: string | undefined };
    props: { reference: MarkdownEndpointReference };
    cacheKey: string;
  }>
> {
  const { markdownAssets } = await markdownIndexes();
  return markdownAssets
    .filter(
      (asset) =>
        asset.collection === options.collection &&
        asset.surface === options.surface,
    )
    .map((asset) => ({
      params: { slug: entryRouteKey(asset.id) || undefined },
      props: {
        reference: {
          collection: asset.collection,
          id: asset.id,
          surface: asset.surface,
        } satisfies MarkdownEndpointReference,
      },
      cacheKey: asset.digest,
    }));
}

export async function getMarkdownPayload(options: {
  collection: string;
  surface: MarkdownEndpointSurface;
  slug?: string;
  reference?: MarkdownEndpointReference;
  context?: AgentEndpointContext;
}): Promise<MarkdownEndpointPayload | null> {
  if (
    !(await selectedApiOutputIsDefault(
      options.reference?.collection ?? options.collection,
      options.context?.request,
    ))
  )
    return null;
  const indexes = await markdownIndexes();
  const asset = options.reference
    ? indexes.markdownByIdentity.get(markdownIdentity(options.reference))
    : indexes.markdownByRoute.get(markdownRouteIdentity(options));
  if (!asset) return null;
  return markdownPayload(asset, options.context ?? {});
}

async function markdownPayload(
  asset: MarkdownEndpointAsset,
  context: AgentEndpointContext,
): Promise<MarkdownEndpointPayload> {
  const body = await readAssetBody(asset.path, context);
  return {
    collection: asset.collection,
    id: asset.id,
    surface: asset.surface,
    digest: asset.digest,
    mediaType: asset.mediaType,
    body,
    content: body.slice(asset.contentStart, asset.contentEnd),
  };
}

/**
 * The `{ getStaticPaths, GET }` pair behind a site's Markdown route file.
 * Export both from a prerendered endpoint whose last segment is a static
 * `.md` (or `.mdx`) file name; see {@link markdownRoute}.
 */
export interface MarkdownRoute {
  getStaticPaths: GetStaticPaths;
  GET: APIRoute;
}

/**
 * The response every route factory returns: the payload, a plain 404 when
 * there is none, and on request a detail-free 500 when loading fails. A
 * prerendered route rethrows so the build fails instead.
 */
async function endpointResponse(
  context: APIContext,
  load: () => Promise<{ body: string; mediaType: string } | null>,
): Promise<Response> {
  try {
    const payload = await load();
    if (!payload) return new Response("Not found", { status: 404 });
    return new Response(payload.body, {
      headers: { "Content-Type": payload.mediaType },
    });
  } catch (error) {
    if (context.isPrerendered) throw error;
    console.error(error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

function requestAssetUrl(url: URL, base: string): string | undefined {
  const prefix = base.replace(/\/+$/u, "");
  let pathname = url.pathname;
  if (prefix) {
    if (!pathname.startsWith(`${prefix}/`)) return undefined;
    pathname = pathname.slice(prefix.length);
  }
  try {
    return decodeURI(pathname);
  } catch {
    return undefined;
  }
}

function createMarkdownRoute(surface: MarkdownEndpointSurface): MarkdownRoute {
  return {
    async getStaticPaths({ routePattern }) {
      const [{ markdownAssets }, { routes }] = await Promise.all([
        markdownIndexes(),
        import("virtual:nimbus/markdown-routes"),
      ]);
      const index = findOwnMarkdownRoute(routes, routePattern, surface);
      const own = routes[index]!;
      return markdownAssets.flatMap((asset) => {
        if (asset.surface !== surface) return [];
        const params = routeParams(own, asset.url);
        if (!params || higherMarkdownRouteOwner(routes, index, asset.url)) {
          return [];
        }
        const reference: MarkdownEndpointReference = {
          collection: asset.collection,
          id: asset.id,
          surface: asset.surface,
        };
        return [{ params, props: { reference }, cacheKey: asset.digest }];
      });
    },
    GET: (context) =>
      endpointResponse(context, async () => {
        const indexes = await markdownIndexes();
        const reference = (
          context.props as { reference?: MarkdownEndpointReference }
        ).reference;
        let asset: MarkdownEndpointAsset | undefined;
        if (reference) {
          asset = indexes.markdownByIdentity.get(markdownIdentity(reference));
        } else {
          const { base } = await loadAgentEndpointAssets();
          const url = requestAssetUrl(context.url, base);
          asset = url ? indexes.markdownByUrl.get(url) : undefined;
        }
        if (!asset && surface === "markdown" && !reference) {
          // Homepage Markdown without a root content entry, on a
          // request-rendered root route: no asset exists at /index.md and a
          // prebuilt /llms.txt can't be reached by rewrite, so the factory
          // serves the site llms index itself.
          const { base } = await loadAgentEndpointAssets();
          if (requestAssetUrl(context.url, base) === "/index.md") {
            const fallback = await getLlmsPayload(
              { scope: "site", surface: "index" },
              { request: context.request },
            );
            if (fallback) {
              return {
                body: fallback.body,
                mediaType: "text/markdown; charset=utf-8",
              };
            }
          }
        }
        if (!asset || asset.surface !== surface) return null;
        if (
          !(await selectedApiOutputIsDefault(asset.collection, context.request))
        )
          return null;
        return markdownPayload(asset, { request: context.request });
      }),
  };
}

/**
 * The site-wide clean-Markdown route. One file serves every indexed
 * collection's `/<page>/index.md`, API pages included:
 *
 * ```ts
 * // src/pages/[...slug]/index.md.ts
 * import { markdownRoute } from "@cloudflare/nimbus-docs/agent-endpoints";
 *
 * export const prerender = true;
 * export const { GET, getStaticPaths } = markdownRoute();
 * ```
 *
 * The route serves only the asset URLs its own pattern matches and skips any
 * URL a more specific Markdown route file owns, so adding
 * `src/pages/changelog/[...slug]/index.md.ts` takes over the changelog. The
 * file must stay prerendered; Nimbus fails the build otherwise.
 */
export function markdownRoute(): MarkdownRoute {
  return createMarkdownRoute("markdown");
}

/**
 * The site-wide authored-source route: `/<page>/index.mdx` for every
 * collection with an authored body. API pages have no source and get no
 * `.mdx`. Same rules as {@link markdownRoute}.
 */
export function markdownSourceRoute(): MarkdownRoute {
  return createMarkdownRoute("source");
}

const LLMS_FULL_REMOVED =
  "nimbus-docs: llms-full.txt was removed in 0.18.0. Delete the route that serves it (usually src/pages/llms-full.txt.ts); see upgrade entry llms-full-removed.";

/** @deprecated Removed in 0.18.0; throws with upgrade guidance. */
export function llmsFullRoute(): never {
  throw new Error(LLMS_FULL_REMOVED);
}

export async function getLlmsPayload(
  reference: LlmsEndpointReference,
  context: AgentEndpointContext = {},
): Promise<LlmsEndpointPayload | null> {
  // A route written before llms-full.txt was removed still asks for it. Fail
  // the build rather than publish a "Not found" body as the file.
  if (
    reference.scope === "site" &&
    (reference as { surface: string }).surface !== "index"
  ) {
    throw new Error(LLMS_FULL_REMOVED);
  }
  if (
    reference.scope === "section" &&
    !(await selectedApiOutputIsDefault(
      reference.section.split("/")[0]!,
      context.request,
    ))
  )
    return null;
  const { llmsByIdentity } = await llmsIndex();
  const asset = llmsByIdentity.get(llmsIdentity(reference));
  if (!asset) return null;
  return {
    ...reference,
    digest: asset.digest,
    mediaType: asset.mediaType,
    body: await readAssetBody(asset.path, context),
  };
}

export async function getLlmsStaticPaths(context?: {
  routePattern?: string;
}): Promise<
  Array<{
    params: { section: string };
    props: { reference: LlmsEndpointReference };
    cacheKey: string;
  }>
> {
  const [{ llmsAssets }, { routes }] = await Promise.all([
    llmsIndex(),
    import("virtual:nimbus/markdown-routes"),
  ]);
  // Skip sections a more specific llms.txt route owns: a mounted collection
  // following its own rendering mode gets its own `/<mount>/llms.txt` route,
  // and this shared route must not also prerender that URL.
  let ownIndex = -1;
  if (context?.routePattern) {
    try {
      ownIndex = findOwnMarkdownRoute(routes, context.routePattern, "llms");
    } catch {
      ownIndex = -1;
    }
  }
  return llmsAssets
    .filter(
      (
        asset,
      ): asset is Extract<
        LlmsEndpointAsset,
        { scope: "section" }
      > => asset.scope === "section" && asset.surface === "index",
    )
    .filter(
      (asset) =>
        ownIndex < 0 ||
        !higherMarkdownRouteOwner(
          routes,
          ownIndex,
          `/${asset.section}/llms.txt`,
        ),
    )
    .map((asset) => ({
      params: { section: asset.section },
      props: {
        reference: {
          scope: asset.scope,
          surface: asset.surface,
          section: asset.section,
        } satisfies LlmsEndpointReference,
      },
      cacheKey: asset.digest,
    }));
}

/** The `{ GET }` behind `src/pages/llms.txt.ts`. */
export interface LlmsRoute {
  GET: APIRoute;
}

/** The `{ getStaticPaths, GET }` behind `src/pages/[section]/llms.txt.ts`. */
export interface LlmsSectionRoute {
  getStaticPaths: GetStaticPaths;
  GET: APIRoute;
}

/**
 * The site's `/llms.txt` index:
 *
 * ```ts
 * // src/pages/llms.txt.ts
 * import { llmsRoute } from "@cloudflare/nimbus-docs/agent-endpoints";
 *
 * export const prerender = true;
 * export const { GET } = llmsRoute();
 * ```
 *
 * `GET` returns 404 when the index is missing and, on request, a 500 without
 * details when its asset can't be read. Wrap `GET` to customize the response.
 */
export function llmsRoute(): LlmsRoute {
  return {
    GET: (context) =>
      endpointResponse(context, () =>
        getLlmsPayload(
          { scope: "site", surface: "index" },
          { request: context.request },
        ),
      ),
  };
}

/**
 * Every per-section `/<section>/llms.txt` index, one path per section:
 *
 * ```ts
 * // src/pages/[section]/llms.txt.ts
 * import { llmsSectionRoute } from "@cloudflare/nimbus-docs/agent-endpoints";
 *
 * export const prerender = true;
 * export const { GET, getStaticPaths } = llmsSectionRoute();
 * ```
 *
 * The route's parameter must be named `section`. On request, `GET` reads it
 * from `params.section` and returns 404 for an unknown section. Same error
 * rules as {@link llmsRoute}.
 */
export function llmsSectionRoute(): LlmsSectionRoute {
  return {
    getStaticPaths: getLlmsStaticPaths,
    GET: (context) =>
      endpointResponse(context, async () => {
        const reference =
          (context.props as { reference?: LlmsEndpointReference }).reference ??
          (context.params.section
            ? {
                scope: "section" as const,
                surface: "index" as const,
                section: context.params.section,
              }
            : undefined);
        if (!reference) return null;
        return getLlmsPayload(reference, { request: context.request });
      }),
  };
}
