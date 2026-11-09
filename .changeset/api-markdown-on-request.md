---
"@cloudflare/nimbus-docs": minor
---

- Request-rendered API collections no longer bake their pages' Markdown. The `.md` route, `Accept: text/markdown` and MCP `get_page` render it on request from the page record the server already holds, through the serialization the build uses, so the bytes equal the file a build-rendered site writes. Docs pages, static sites and `"build"` collections are unchanged.
- A page's Markdown response carries an `ETag` of its bytes, and a request that prefers Markdown is answered without rendering the page's HTML.
