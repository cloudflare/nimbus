---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- Request-rendered API pages load the nested fields of very large request and response bodies after the page, through a server island.
- API pages show the sidebar filter. With `sidebar: "on-demand"` it also finds pages the sidebar hasn't loaded.
