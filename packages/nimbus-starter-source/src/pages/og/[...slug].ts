import { getOgImagePages } from "@cloudflare/nimbus-docs/runtime";
import { OGImageRoute } from "astro-og-canvas";
import { ogCardConfig } from "./_og-card-config";

// Prerender every OG card as a static asset so `output: "server"` doesn't
// turn image generation into an on-demand route.
export const prerender = true;

// One card per page, written at the page's `ogImageUrl`.
export const { getStaticPaths, GET } = await OGImageRoute({
  pages: await getOgImagePages(),
  getImageOptions: (_path, page) => ({
    title: page.title,
    description: page.description ?? "",
    ...ogCardConfig,
  }),
});
