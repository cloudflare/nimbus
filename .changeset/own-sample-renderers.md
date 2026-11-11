---
"@cloudflare/nimbus-docs": patch
"@cloudflare/create-nimbus-docs": patch
---

- Generated cURL, TypeScript and Python samples no longer need `@readme/httpsnippet`; only `openapi-sampler` is needed for generated samples, and you can uninstall `@readme/httpsnippet`.
- A TypeScript sample's options object wraps when its line would pass 80 characters, as the other samples already do.
