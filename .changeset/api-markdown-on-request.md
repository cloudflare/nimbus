---
"@cloudflare/nimbus-docs": minor
---

- Request-rendered API collections no longer bake their pages' Markdown. The `.md` route, `Accept: text/markdown` and MCP `get_page` render it on request from the page record the server already holds, through the serialization the build uses, so the bytes equal the file a build-rendered site writes. Docs pages, static sites and `"build"` collections are unchanged.
- A page's Markdown response carries an `ETag` of its bytes, and a request that prefers Markdown is answered without rendering the page's HTML.
- On a site whose `llms.txt`, section `llms.txt` and `llms-full.txt` routes render on request, those documents are no longer baked either: the server makes the indexes from the build's page list when asked, and `llms-full.txt` becomes an index of per-section parts, each assembled on its first request and kept for the build's life. Build-rendered routes keep writing the same files.
