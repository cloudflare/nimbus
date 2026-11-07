---
"@cloudflare/nimbus-docs": patch
---

- In `astro dev`, new pages, and collections added to `content.config.ts`, reach pages, Markdown, the sidebar and `llms.txt` without a restart.
- A site whose `content.config.ts` declares no `docs` collection builds with the starter's docs route, which serves no pages.
