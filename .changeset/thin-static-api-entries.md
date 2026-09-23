---
"@cloudflare/nimbus-docs": patch
---

Reduce static API reference build memory by storing lightweight collection entries and projecting complete pages during prerendering. Server output continues to use prepared entries so requests do not parse OpenAPI specifications. Keep build-only Markdown parsing out of generated server bundles.
