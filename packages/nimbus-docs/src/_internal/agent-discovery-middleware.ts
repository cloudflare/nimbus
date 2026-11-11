import type { APIContext, MiddlewareHandler } from "astro";
import { capabilities, options } from "virtual:nimbus/agent-capabilities";
import { agentHomepageLinks } from "./agent-discovery.js";
import { prefersMarkdown } from "./markdown-negotiation.js";
import { toRouteKey, withBase } from "./url.js";

const home = withBase("/", options.base).replace(/\/$/, "");
const isHome = (pathname: string) => pathname.replace(/\/$/, "") === home;

function withHeaders(response: Response, set: (headers: Headers) => void): Response {
  const headers = new Headers(response.headers);
  set(headers);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function varyOnAccept(headers: Headers): void {
  const current = headers.get("Vary");
  if (current === "*" || /(^|,)\s*accept\s*(,|$)/i.test(current ?? "")) return;
  headers.set("Vary", current ? `${current}, Accept` : "Accept");
}

/** The indexed entry behind a page URL, so Markdown is found by identity. */
async function pageEntry(context: APIContext) {
  const entry = await routeEntry(context);
  if (!entry) return undefined;
  return (await versionSelectsDefault(context, entry.collection)) ? entry : undefined;
}

/** The content entry whose URL is the request's path, if one is. */
async function routeEntry(context: APIContext) {
  const prefix = options.base.replace(/\/+$/, "");
  const pathname = context.url.pathname;
  // Under a base, the slashless root (`/docs`, the homepage with `trailingSlash: "never"`) is the site's too.
  if (prefix && pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return undefined;
  const route = toRouteKey(pathname.slice(prefix.length) || "/");
  // Separate destructured imports keep the Worker tree-shakable; a
  // `Promise.all` of whole modules pulls in the Markdown renderer.
  const { getIndexedEntries } = await import("../runtime.js");
  return (await getIndexedEntries()).find((item) => toRouteKey(item.url) === route);
}

/**
 * Whether the request's version selection is the collection's default (or
 * the collection has no query versions). Only the default version's pages
 * have Markdown.
 */
async function versionSelectsDefault(context: APIContext, collection: string): Promise<boolean> {
  // Query-addressed versions: the index holds only the default version, so a
  // pathname match under `?version=<non-default>` would negotiate the
  // DEFAULT version's Markdown beneath another version's HTML. Those pages
  // have no per-page Markdown affordance; don't negotiate. Path-mode
  // collections return no routing and keep ignoring the parameter.
  const { loadNimbusConfig } = await import("./runtime-config.js");
  const { apiQueryRouting, selectApiVersion } = await import("./api/resolve-versions.js");
  const routing = apiQueryRouting((await loadNimbusConfig()).api, collection);
  return !routing || selectApiVersion(context.url.searchParams, routing) === routing.defaultVersion;
}

/**
 * Whether the homepage negotiates: a route serves its Markdown and, when a
 * content entry owns `/` (a root-mounted API's overview), the request selects
 * that entry's default version. With no entry at `/`, the llms fallback stands.
 */
async function homepageNegotiates(context: APIContext): Promise<boolean> {
  if (!capabilities.homepageMarkdownUrl) return false;
  const entry = await routeEntry(context);
  return !entry || versionSelectsDefault(context, entry.collection);
}

async function homepageMarkdownFallback(context: APIContext): Promise<Response | undefined> {
  const summary = await context.rewrite("/llms.txt");
  // A 304 is the index saying the client already holds it; it carries no Content-Type.
  if (summary.status === 304) return summary;
  return summary.status === 200
    ? withHeaders(summary, (headers) => headers.set("Content-Type", "text/markdown; charset=utf-8"))
    : undefined;
}

/**
 * The Markdown a route of the site serves at `pathname`. Cloudflare reads
 * assets first. A URL a request-rendered route owns is rewritten to it, and
 * that answer is final: Astro's rewrite replaces the request's route, so the
 * caller must never call `next()` after it. A URL a prerendered route owns
 * is a file: read from the assets or, off Cloudflare, from the configured
 * origin; when neither has it, `undefined`, and the page renders as HTML.
 */
async function markdownResponse(context: APIContext, pathname: string): Promise<Response | undefined> {
  const path = withBase(pathname, options.base);
  let rewrote = false;
  try {
    // Loaded on demand: the binding module exists only where the Worker runs.
    const { fetchAgentEndpointAsset } = await import("virtual:nimbus/agent-endpoint-asset-loader");
    const asset = await fetchAgentEndpointAsset(path, context.request);
    if (asset && asset.status !== 404) return asset;
    const { routes } = await import("virtual:nimbus/markdown-routes");
    const owner = routes.find((route) => route.regex.test(pathname));
    const homepageFallback = pathname === "/index.md" && options.homepageMarkdownFallback;
    if ((owner !== undefined && !owner.prerendered) || homepageFallback) {
      rewrote = true;
      if (homepageFallback) {
        // A prebuilt /llms.txt can't be reached by rewrite from a
        // request-rendered homepage; the /index.md route's factory serves
        // the site llms payload itself when this fails.
        try {
          const fallback = await homepageMarkdownFallback(context);
          if (fallback) return fallback;
        } catch {}
      }
      const route = await context.rewrite(pathname);
      // A 304 carries no Content-Type: it is the Markdown route saying the client already has it.
      const isMarkdown = route.status === 304 || (route.headers.get("Content-Type")?.includes("text/markdown") ?? false);
      // The owner's own failure reads the same negotiated as direct.
      if (isMarkdown || route.status >= 500) return route;
      return new Response("Not found", { status: 404, headers: { "Content-Type": "text/markdown; charset=utf-8" } });
    }
    if (!asset) {
      // No assets binding (non-Cloudflare server): the prerendered file lives
      // at the deployed origin, and only there.
      const origin = import.meta.env.DEV ? context.url.origin : new URL(options.site).origin;
      const url = new URL(path, origin);
      if (url.origin === origin) {
        const file = await fetch(url, { method: context.request.method, redirect: "error" });
        if (file.ok) return file;
      }
    }
    return undefined;
  } catch (error) {
    if (!rewrote) return undefined;
    console.error(error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

/**
 * The negotiated form: the Markdown response a route of the site serves,
 * varying on Accept, with the homepage's discovery links. The page's HTML
 * route never runs, so the headers are the Markdown route's.
 */
async function negotiatedMarkdown(context: APIContext, pathname: string, atHome: boolean): Promise<Response | undefined> {
  const markdown = await markdownResponse(context, pathname);
  if (!markdown) return undefined;
  const headers = new Headers(markdown.headers);
  for (const name of ["Content-Length", "Content-Encoding"]) headers.delete(name);
  if (markdown.ok) headers.set("Content-Type", markdown.headers.get("Content-Type") ?? "text/markdown; charset=utf-8");
  varyOnAccept(headers);
  // A 304 carries what its 200 would, so a cache revalidating the homepage keeps the links.
  if (atHome && (markdown.ok || markdown.status === 304)) {
    const current: typeof capabilities = Reflect.get(context.locals, Symbol.for("nimbus.agent-capabilities")) ?? capabilities;
    for (const value of agentHomepageLinks(current, options)) headers.append("Link", value);
  }
  return new Response(context.request.method === "HEAD" ? null : markdown.body, {
    status: markdown.status,
    statusText: markdown.statusText,
    headers,
  });
}

/**
 * A missing page: an HTML 404, or a page helper's empty one (untyped or
 * `text/plain`), which Astro replaces with the 404 page. An endpoint's own
 * 404, such as JSON, stays as it is.
 */
function isMissingPage(response: Response): boolean {
  if (response.status !== 404) return false;
  const type = response.headers.get("Content-Type");
  if (type?.includes("text/html")) return true;
  return response.body === null && (!type || type.startsWith("text/plain"));
}

/** A request-rendered 404 an agent can read: where to look instead. */
function notFoundMarkdown(context: APIContext, response: Response): Response {
  const absolute = (pathname: string) => new URL(withBase(pathname, options.base), options.site).href;
  const body = [
    "# Not found",
    "",
    `There is no page at \`${context.url.pathname}\`.`,
    "",
    ...(capabilities.llmsUrl ? [`- Documentation index: ${capabilities.llmsUrl}`] : []),
    `- Sitemap: ${absolute("/sitemap-index.xml")}`,
    "",
  ].join("\n");
  const headers = new Headers(response.headers);
  for (const name of ["Content-Length", "Content-Encoding", "ETag", "Last-Modified"]) headers.delete(name);
  headers.set("Content-Type", "text/markdown; charset=utf-8");
  varyOnAccept(headers);
  // A body for HEAD too: Astro replaces a bodiless 404 with the HTML 404 page,
  // and the server sends no body for HEAD anyway.
  return new Response(body, { status: 404, statusText: response.statusText, headers });
}

export const onRequest: MiddlewareHandler = async (context, next) => {
  if (!["GET", "HEAD"].includes(context.request.method)) return next();
  // Static builds copy the site's emitted llms.txt after prerendering. In dev
  // and for request-rendered llms.txt routes, reuse the owner's existing route.
  if (
    options.homepageMarkdownFallback &&
    context.url.pathname === withBase("/index.md", options.base) &&
    capabilities.llmsUrl
  ) {
    try {
      const markdown = await homepageMarkdownFallback(context);
      if (markdown) return markdown;
    } catch {}
  }
  // Only a request-rendered page on server output negotiates: a static host
  // answers from its files before any middleware runs.
  const live = options.output === "server" && !context.isPrerendered;
  const atHome = isHome(context.url.pathname);
  // A client that prefers Markdown gets a published page's Markdown without
  // the page's HTML being rendered: the request goes to the route that
  // serves the Markdown, so a site's wrapper around it still applies. Pages
  // with no published Markdown, and clients preferring HTML, render as usual.
  if (live && prefersMarkdown(context.request.headers.get("Accept"))) {
    const markdownPath = atHome
      ? (await homepageNegotiates(context))
        ? "/index.md"
        : undefined
      : (await pageEntry(context))?.markdownUrl;
    if (markdownPath) {
      const markdown = await negotiatedMarkdown(context, markdownPath, atHome);
      if (markdown) return markdown;
    }
  }
  const response = await next();
  if (options.output === "server" && isMissingPage(response)) {
    // Both forms vary on Accept, so a cache never serves one for the other.
    return prefersMarkdown(context.request.headers.get("Accept"))
      ? notFoundMarkdown(context, response)
      : withHeaders(response, varyOnAccept);
  }
  if (response.status !== 200) return response;
  const html = live && (response.headers.get("Content-Type")?.includes("text/html") ?? false);
  // A page negotiates only when a route of the site serves its Markdown.
  const negotiates = html && (atHome ? await homepageNegotiates(context) : !!(await pageEntry(context))?.markdownUrl);
  if (!negotiates && !atHome) return response;
  const headers = new Headers(response.headers);
  if (negotiates) varyOnAccept(headers);
  if (atHome) {
    const current: typeof capabilities = Reflect.get(context.locals, Symbol.for("nimbus.agent-capabilities")) ?? capabilities;
    for (const value of agentHomepageLinks(current, options)) headers.append("Link", value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};
