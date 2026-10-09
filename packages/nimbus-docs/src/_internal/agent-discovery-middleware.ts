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
  const prefix = options.base.replace(/\/+$/, "");
  const pathname = context.url.pathname;
  if (prefix && !pathname.startsWith(`${prefix}/`)) return undefined;
  const route = toRouteKey(pathname.slice(prefix.length) || "/");
  // Separate destructured imports keep the Worker tree-shakable; a
  // `Promise.all` of whole modules pulls in the Markdown renderer.
  const { getIndexedEntries } = await import("../runtime.js");
  const entry = (await getIndexedEntries()).find((item) => toRouteKey(item.url) === route);
  if (!entry) return undefined;
  // Query-addressed versions: the index holds only the default version, so a
  // pathname match under `?version=<non-default>` would negotiate the
  // DEFAULT version's Markdown beneath another version's HTML. Those pages
  // have no per-page Markdown affordance; don't negotiate. Path-mode
  // collections return no routing and keep ignoring the parameter.
  const { loadNimbusConfig } = await import("./runtime-config.js");
  const { apiQueryRouting, selectApiVersion } = await import("./api/resolve-versions.js");
  const routing = apiQueryRouting((await loadNimbusConfig()).api, entry.collection);
  if (routing && selectApiVersion(context.url.searchParams, routing) !== routing.defaultVersion) {
    return undefined;
  }
  return entry;
}

async function homepageMarkdownFallback(context: APIContext): Promise<Response | undefined> {
  const summary = await context.rewrite("/llms.txt");
  return summary.status === 200
    ? withHeaders(summary, (headers) => headers.set("Content-Type", "text/markdown; charset=utf-8"))
    : undefined;
}

/**
 * Cloudflare reads assets first, then resolves request-rendered alternates
 * through Astro. Other adapters fetch from the configured site origin.
 */
async function publishedMarkdown(context: APIContext, pathname: string): Promise<Response | undefined> {
  const path = withBase(pathname, options.base);
  try {
    // Loaded on demand: the binding module exists only where the Worker runs.
    const { fetchAgentEndpointAsset } = await import("virtual:nimbus/agent-endpoint-asset-loader");
    const asset = await fetchAgentEndpointAsset(path, context.request);
    if (asset?.status === 404) {
      if (pathname === "/index.md" && options.homepageMarkdownFallback) {
        // A prebuilt /llms.txt can't be reached by rewrite from a
        // request-rendered homepage; fall through to the /index.md route,
        // whose factory serves the site llms payload itself.
        try {
          const fallback = await homepageMarkdownFallback(context);
          if (fallback) return fallback;
        } catch {}
      }
      const route = await context.rewrite(pathname);
      return route.ok && route.headers.get("Content-Type")?.includes("text/markdown") ? route : undefined;
    }
    if (asset) return asset.ok ? asset : undefined;
    // No assets binding (non-Cloudflare server): a request-rendered Markdown
    // route has no public file, so try the in-process rewrite first and fall
    // back to fetching the deployed file from the configured origin.
    try {
      const route = await context.rewrite(pathname);
      if (route.ok && route.headers.get("Content-Type")?.includes("text/markdown")) return route;
    } catch {}
    const origin = import.meta.env.DEV ? context.url.origin : new URL(options.site).origin;
    const url = new URL(path, origin);
    if (url.origin !== origin) return undefined;
    const file = await fetch(url, { method: context.request.method, redirect: "error" });
    return file.ok ? file : undefined;
  } catch {
    return undefined;
  }
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
  const response = await next();
  if (response.status !== 200) return response;
  const atHome = isHome(context.url.pathname);
  // Only a request-rendered page on server output negotiates: a static host
  // answers from its files before any middleware runs.
  const live = options.output === "server" && !context.isPrerendered && (response.headers.get("Content-Type")?.includes("text/html") ?? false);
  const entry = live && !atHome ? await pageEntry(context) : undefined;
  const negotiates = live && (atHome ? !!capabilities.homepageMarkdownUrl : !!entry);
  let markdown: Response | undefined;
  if (negotiates && prefersMarkdown(context.request.headers.get("Accept"))) {
    markdown = await publishedMarkdown(context, atHome ? "/index.md" : entry!.markdownUrl);
  }
  if (!negotiates && !atHome) return response;
  // The Markdown form keeps the page's own response headers and swaps the body.
  const headers = new Headers(response.headers);
  if (markdown) {
    for (const name of ["Content-Length", "Content-Encoding", "ETag", "Last-Modified"]) headers.delete(name);
    headers.set("Content-Type", markdown.headers.get("Content-Type") ?? "text/markdown; charset=utf-8");
  }
  if (negotiates) varyOnAccept(headers);
  if (atHome) {
    const current: typeof capabilities = Reflect.get(context.locals, Symbol.for("nimbus.agent-capabilities")) ?? capabilities;
    for (const value of agentHomepageLinks(current, options)) headers.append("Link", value);
  }
  return new Response(markdown ? (context.request.method === "HEAD" ? null : markdown.body) : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
