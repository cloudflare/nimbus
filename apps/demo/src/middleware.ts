import { defineMiddleware } from "astro:middleware";

// A page the Worker renders (HTML, its Markdown version, or an llms.txt) that
// sets no `Cache-Control` of its own may be cached but is checked on every
// use, so a deploy shows at once. Other responses, such as the MCP server's,
// keep whatever they send.
const REVALIDATE = "public, max-age=0, must-revalidate";
const isPage = (type: string | null) => /^text\/(html|markdown|plain)\b/i.test(type ?? "");

export const onRequest = defineMiddleware(async ({ request }, next) => {
  const response = await next();
  const cache =
    (request.method === "GET" || request.method === "HEAD") &&
    !response.headers.has("Cache-Control") &&
    isPage(response.headers.get("Content-Type"));
  // Workers Builds previews (`build:workers`) keep search engines off pages the
  // Worker renders; `_headers` covers the static files.
  const noindex = import.meta.env.DEMO_NOINDEX;
  if (!cache && !noindex) return response;
  const out = new Response(response.body, response);
  if (cache) out.headers.set("Cache-Control", REVALIDATE);
  if (noindex) out.headers.set("X-Robots-Tag", "noindex");
  return out;
});
