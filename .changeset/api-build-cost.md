---
"@cloudflare/nimbus-docs": patch
---

Cheaper API builds and a lighter Worker. The spec is parsed once for the walk and its ref-preserving copy, with a second parse only if the parser ever resolves in place. For an API with `bundle: false`, the "Prepared API pages" line says what changed when a version is rebuilt. Agent files are staged by clone and the search inventory reads the Markdown twins instead of rendering every page again. A server build reads the agent-endpoint manifest from `_nimbus/agent-endpoint-assets/manifest.json` instead of inlining it, and staging fails with a clear error if that file would exceed Cloudflare's 25 MiB static file limit.
