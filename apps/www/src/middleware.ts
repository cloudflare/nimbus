import { defineMiddleware } from "astro:middleware";

// Workers Builds previews (`build:workers`) keep search engines off pages the
// Worker renders; `_headers` covers the static files.
export const onRequest = defineMiddleware(async (_, next) => {
  const response = await next();
  if (!import.meta.env.WWW_NOINDEX) return response;
  const marked = new Response(response.body, response);
  marked.headers.set("X-Robots-Tag", "noindex");
  return marked;
});
