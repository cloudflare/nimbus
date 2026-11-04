import { defineMiddleware } from "astro:middleware";

// What the Worker renders (pages, their Markdown versions, llms.txt) may be
// cached but is checked on every use, so a deploy shows at once. A response
// that chose its own policy keeps it.
const REVALIDATE = "public, max-age=0, must-revalidate";

export const onRequest = defineMiddleware(async (_, next) => {
  const response = await next();
  const cache = !response.headers.has("Cache-Control");
  // Workers Builds previews (`build:workers`) keep search engines off pages the
  // Worker renders; `_headers` covers the static files.
  const noindex = import.meta.env.DEMO_NOINDEX;
  if (!cache && !noindex) return response;
  const out = new Response(response.body, response);
  if (cache) out.headers.set("Cache-Control", REVALIDATE);
  if (noindex) out.headers.set("X-Robots-Tag", "noindex");
  return out;
});
