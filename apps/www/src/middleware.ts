import { defineMiddleware } from "astro:middleware";

// One URL per page. The deploy also answers `http://`, `www.` and `/page`;
// search engines and assistants that fetch a page land on the canonical
// `https://nimbus-docs.com/page/` in one hop. Moved pages are Astro's
// `redirects` (astro.config.ts), answered before this runs, and their
// destinations carry the slash so they are one hop too.
const host = "nimbus-docs.com";

// Page URLs end in a slash. Files (`/llms.txt`, `/why-nimbus/index.md`,
// `/og.png`) and the endpoints agents call (`/mcp`, `/.well-known/…`,
// `/_nimbus/…`) keep the form they're published at.
function slashForm(pathname: string): string | null {
  if (pathname === "/" || pathname.endsWith("/")) return null;
  if (/^\/(mcp|_|\.well-known)/.test(pathname)) return null;
  if (pathname.slice(pathname.lastIndexOf("/") + 1).includes(".")) return null;
  return `${pathname}/`;
}

function isHtmlPage(response: Response): boolean {
  const mediaType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return response.status === 200 && mediaType === "text/html";
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, url } = context;
  // Workers Builds previews (`build:workers`) keep search engines off
  // everything the Worker answers; `_headers` covers the static files.
  const finish = (response: Response) => {
    if (!import.meta.env.WWW_NOINDEX) return response;
    const marked = new Response(response.body, response);
    marked.headers.set("X-Robots-Tag", "noindex");
    return marked;
  };
  const read = request.method === "GET" || request.method === "HEAD";
  if (read && (url.hostname === `www.${host}` || (url.hostname === host && url.protocol === "http:"))) {
    return finish(context.redirect(`https://${host}${url.pathname}${url.search}`, 301));
  }
  const response = await next();
  // Only a page that rendered moves to its slash form; a 404 stays a 404.
  const slashed = read ? slashForm(url.pathname) : null;
  if (slashed && isHtmlPage(response)) {
    await response.body?.cancel().catch(() => {});
    const redirect = context.redirect(`${slashed}${url.search}`, 301);
    // The page negotiates on `Accept` (its Markdown version at the same
    // URL), so the redirect must not be cached across that axis either.
    const vary = response.headers.get("vary");
    if (vary) redirect.headers.set("Vary", vary);
    return finish(redirect);
  }
  return finish(response);
});
