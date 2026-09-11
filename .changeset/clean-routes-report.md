---
"@cloudflare/nimbus-docs": patch
"@cloudflare/create-nimbus-docs": patch
---

Allow user-owned Astro pages and scaffolded Markdown and `llms.txt` endpoints to use native rendering semantics while retaining entrypoint-aware checks for active Nimbus contracts and composing with unrelated integration routes. These dynamic endpoints now resolve their payloads when rendered on request. Endpoint helpers now live at `@cloudflare/nimbus-docs/agent-endpoints`; the existing `@cloudflare/nimbus-docs/publication` entrypoint remains supported. Sub-path sitemaps now list the deployment root once.
