---
{
  "name": "ai-native",
  "type": "registry:feature",
  "title": "Markdown and llms.txt endpoints",
  "description": "Add alternate Markdown/MDX versions, llms.txt indexes, llms-full.txt, robots.txt, and an AgentDirective to a Nimbus docs site.",
  "markers": ["src/pages/llms.txt.ts", "src/pages/llms-full.txt.ts", "src/pages/[...slug]/index.md.ts"]
}
---

# Markdown and llms.txt endpoints

You are helping the user add alternate Markdown/MDX versions and `llms.txt` indexes to an existing Nimbus docs site. Their generated content is deterministic on every deployment provider.

Read this entire file before making changes. The target project should already depend on `@cloudflare/nimbus-docs` and use the starter-style routes/layouts.

## What to add

Add the same user-owned files the canonical starter ships:

- `src/pages/[...slug]/index.md.ts`
- `src/pages/[...slug]/index.mdx.ts`
- `src/pages/llms.txt.ts`
- `src/pages/llms-full.txt.ts`
- `src/pages/[...section]/llms.txt.ts`
- `src/pages/robots.txt.ts`
- `src/components/AgentDirective.astro`

Each route file switches its surface on: the page Markdown versions, the `.mdx` source versions, the site index, the full document and the section indexes. The site may leave any of them out, and the build then makes nothing for that surface and links nothing to it.

Then wire the layout/page props:

- `src/layouts/BaseLayout.astro` imports `AgentDirective`, accepts `markdownUrl`, emits `<link rel="alternate" type="text/markdown">`, and renders `<AgentDirective />` when `markdownUrl` exists.
- `src/layouts/DocsLayout.astro` accepts `markdownUrl` and forwards it to `BaseLayout`.
- `src/pages/[...slug].astro` passes the page's `markdownUrl` from `getDocsPage(Astro)` to `DocsLayout`.

Do not add an `ai` config block or an MCP server. Nimbus prepares the endpoint payloads at build time. The agent routes render the way `rendering` renders the pages they describe.

## Reference implementation

Use the route helpers from `@cloudflare/nimbus-docs/agent-endpoints`. The files below are for a site built ahead of time on `output: "static"`; after writing them, run `nimbus-docs check --fix` so they match the site's `rendering` and `output`.

```ts title="src/pages/[...slug]/index.md.ts"
import { markdownRoute } from "@cloudflare/nimbus-docs/agent-endpoints";

export const { GET, getStaticPaths } = markdownRoute();
```

```ts title="src/pages/[...slug]/index.mdx.ts"
import { markdownSourceRoute } from "@cloudflare/nimbus-docs/agent-endpoints";

export const { GET, getStaticPaths } = markdownSourceRoute();
```

These two files serve every collection, including collections added later. Do not add per-collection Markdown routes.

```ts title="src/pages/llms.txt.ts"
import { llmsRoute } from "@cloudflare/nimbus-docs/agent-endpoints";

export const { GET } = llmsRoute();
```

```ts title="src/pages/llms-full.txt.ts"
import { llmsFullRoute } from "@cloudflare/nimbus-docs/agent-endpoints";

export const { GET } = llmsFullRoute();
```

```ts title="src/pages/[...section]/llms.txt.ts"
import { llmsSectionRoute } from "@cloudflare/nimbus-docs/agent-endpoints";

export const { GET, getStaticPaths } = llmsSectionRoute();
```

Each `GET` returns 404 for a missing index and, on request, a 500 without details when the index can't be read.

Use the target project's existing sitemap URL pattern for `robots.txt`. Keep `AgentDirective.astro` visually hidden and link it to the current page's Markdown version and the top-level `llms.txt` index. Adapt layout import paths and props to the project instead of replacing unrelated layout behavior.

## Verification

Run the user's package manager build command (`pnpm build`, `npm run build`, etc.). Confirm:

- `dist/llms.txt` exists.
- `dist/llms-full.txt` exists and contains discoverable current documentation.
- `dist/robots.txt` exists and includes a `Sitemap:` line.
- `dist/<slug>/index.md` exists for every indexed page, in every collection.
- `dist/<slug>/index.mdx` exists for every authored page. API pages have no `.mdx`.
- Section indexes such as `dist/<section>/llms.txt` list their alternate Markdown versions.
- `nimbus-docs check` reports no route file that doesn't match `rendering`, and the build log has no `getStaticPaths() ignored` warning.
- HTML pages include `<link rel="alternate" type="text/markdown" ...>` for docs entries.
- HTML pages include the hidden `[data-ai-agent-directive]` block for docs entries.

If the user deploys to GitHub Pages, remind them to ship `public/.nojekyll` so static `.md` files are not processed by Jekyll. If they need `text/markdown` MIME headers, remind them that this is configured per host (`_headers`, `vercel.json`, CloudFront metadata, etc.).
