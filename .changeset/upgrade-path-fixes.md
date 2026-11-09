---
"@cloudflare/nimbus-docs": patch
---

- Upgrading Nimbus reuses the Vite your Astro already has instead of installing a second copy, which broke type checks of `astro.config.mjs`.
- `migrate --yes` records the reviewed version without reformatting the rest of `nimbus.json`.
- With `sidebar: "on-demand"`, the build accepts an `ApiLayout` that renders the sidebar through a component of your own; it still stops the starter's pre-on-demand layout, whose groups wouldn't open.
