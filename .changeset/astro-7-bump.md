---
"nimbus-docs": minor
"create-nimbus-docs": minor
---

Move to Astro 7

`nimbus-docs` now peers on `astro ^7.0.0` (was `>=6.4.0 <7.0.0`) and builds
against the Astro 7 ecosystem: `@astrojs/mdx ^7`, `@astrojs/markdown-satteri
^0.3.4` (Sätteri `^0.9`), Vite 8. The markdown pipeline — Sätteri plus the
`hastPlugins`/`mdastPlugins` seam and Shiki dual-theme output — is unchanged;
the Sätteri `0.6→0.9` jump left the plugin-definition types intact, so no
seam code moved.

Astro 7 makes Sätteri the default processor, which unblocks opt-in server
output alongside it (the gate for hosted MCP, Ask AI, and content
negotiation).

**Starter templates**: Tailwind v4 now wires through `@tailwindcss/vite`
instead of the PostCSS plugin, which does not build under Astro 7's Vite 8
bundler. Scaffolded projects gain `@tailwindcss/vite` and drop
`@tailwindcss/postcss` + `postcss.config.mjs`.

**Breaking (peer)**: sites must be on Astro 7. The `unified()` escape hatch
for remark/rehype plugins still works, but `@astrojs/markdown-remark` must
now be installed explicitly (`pnpm add @astrojs/markdown-remark`) — pnpm does
not expose it for import even though `@astrojs/mdx` pulls it transitively.
