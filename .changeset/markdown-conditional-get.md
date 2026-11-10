---
"@cloudflare/nimbus-docs": patch
---

- A Markdown, `llms.txt` or `llms-full.txt` request that carries `If-None-Match` with the document's current `ETag` is answered `304 Not Modified`, on request-rendered routes and, on Cloudflare, for the baked files too. A mount's own `llms.txt` now carries an `ETag` like the others.
