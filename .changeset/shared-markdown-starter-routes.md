---
"@cloudflare/create-nimbus-docs": patch
---

The starter's `src/pages/[...slug]/index.md.ts` and `index.mdx.ts` routes now use `markdownRoute()` and `markdownSourceRoute()`, so they serve the Markdown and source versions of every collection. Generated files are unchanged.
