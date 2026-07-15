---
{
  "name": "ai-native",
  "type": "registry:feature",
  "title": "AI-native static surface",
  "description": "Add llms.txt, markdown variants, robots.txt, and an AgentDirective to a Nimbus docs site.",
  "markers": ["src/pages/llms.txt.ts", "src/pages/robots.txt.ts", "src/pages/[...slug]/index.md.ts"]
}
---

# AI-native portable static surface

You are helping the user add Nimbus's portable static AI-discovery surface to an existing Nimbus docs site.

This installs the non-Cloudflare/default strategy: generated `.md` files at build time. New Cloudflare scaffolds use Cloudflare Markdown for Agents by default instead; this feature is for projects that should generate markdown files themselves.

Read this entire file before making changes. The target project should already depend on `nimbus-docs` and use the starter-style routes/layouts.

## What to add

Add the same user-owned files the canonical starter ships:

- `src/pages/[...slug]/index.md.ts`
- `src/pages/llms.txt.ts`
- `src/pages/robots.txt.ts`
- `src/components/AgentDirective.astro`

Then wire the layout/page props:

- `src/layouts/BaseLayout.astro` imports `AgentDirective`, accepts `markdownUrl`, emits `<link rel="alternate" type="text/markdown">`, and renders `<AgentDirective />` when `markdownUrl` exists.
- `src/layouts/DocsLayout.astro` accepts `markdownUrl` and forwards it to `BaseLayout`.
- `src/pages/[...slug].astro` computes `markdownUrl` for docs entries and passes it to `DocsLayout`.

Do not add an `ai` config block. Do not add an MCP server. This feature is build-time/static only.

## Reference implementation

Use the canonical starter as the source of truth:

- `examples/starter/src/pages/[...slug]/index.md.ts`
- `examples/starter/src/pages/llms.txt.ts`
- `examples/starter/src/pages/robots.txt.ts`
- `examples/starter/src/components/AgentDirective.astro`
- `examples/starter/src/layouts/BaseLayout.astro`
- `examples/starter/src/layouts/DocsLayout.astro`
- `examples/starter/src/pages/[...slug].astro`

Copy the patterns, but adapt import paths if the user's project differs.

## Verification

Run the user's package manager build command (`pnpm build`, `npm run build`, etc.). Confirm:

- `dist/llms.txt` exists.
- `dist/robots.txt` exists and includes a `Sitemap:` line.
- `dist/<slug>/index.md` exists for docs entries.
- HTML pages include `<link rel="alternate" type="text/markdown" ...>` for docs entries.
- HTML pages include the hidden `[data-ai-agent-directive]` block for docs entries.

If the user deploys to GitHub Pages, remind them to ship `public/.nojekyll` so static `.md` files are not processed by Jekyll. If they need `text/markdown` MIME headers, remind them that this is configured per host (`_headers`, `vercel.json`, CloudFront metadata, etc.).
