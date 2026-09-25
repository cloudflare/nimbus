---
"@cloudflare/nimbus-docs": minor
---

Return each page's URLs from the page helpers, build OG cards from one path function, and reduce the `llms.txt` routes to one factory call each.

- `getDocsPage`, `getCollectionPage`, `getDocsPageProps`, and `getCollectionPageProps` now return `markdownUrl`, `sourceUrl`, and `ogImageUrl` alongside `entry`, `Content`, and `headings`. `IndexedEntry` gains `ogImageUrl`. All three are site-relative with no base path and come from the same function, so a page route no longer builds them by hand:

  ```astro
  const { entry, Content, headings, markdownUrl, ogImageUrl } = page;
  const socialImage = entry.data.socialImage ?? ogImageUrl;
  ```

- `getOgImagePages()` from `@cloudflare/nimbus-docs/runtime` returns the `pages` map for astro-og-canvas's `OGImageRoute`, one entry per indexed page, keyed so each card is written at the page's `ogImageUrl`. `ogImageUrl` is `/og/<page>.png`, derived from the page's route, the same rule the `api-reference` recipe uses. This fixes broken OG cards: collection and version root pages, such as `/blog/`, linked to `/og/blog/index.png` while the card was written at `/og/blog.png`, and IDs containing a dot, such as `v1.2/guide` or the webhook `payment.succeeded`, had their card name cut at the last dot, so several pages shared one card. noindex pages linked to `/og/<id>.png`, but the old OG route skipped them and never wrote that card. Root pages, dotted IDs, and noindex pages now link to cards that exist.
- `llmsRoute()`, `llmsFullRoute()`, and `llmsSectionRoute()` from `@cloudflare/nimbus-docs/agent-endpoints` return the `{ GET }` behind `src/pages/llms.txt.ts` and `llms-full.txt.ts`, and the `{ GET, getStaticPaths }` behind `src/pages/[section]/llms.txt.ts`. Each `GET` returns 404 for a missing or unknown index and, on request, a 500 without details when the index can't be read, as the starter's routes did:

  ```ts
  // src/pages/[section]/llms.txt.ts
  import { llmsSectionRoute } from "@cloudflare/nimbus-docs/agent-endpoints";

  export const prerender = true;
  export const { GET, getStaticPaths } = llmsSectionRoute();
  ```

- The build now warns about every baked Markdown page and every `llms.txt` index that no prerendered route generated, and names the route that serves it. This catches a shared Markdown route that re-exports `markdownRoute()` from another module and is rendered on request. Sites that serve these pages on request on purpose can ignore the warning.

Hand-built URLs, existing OG routes, and existing `llms.txt` routes keep building with unchanged output. The `page-urls-and-llms-routes` upgrade entry lists the lines each route can drop.
