---
"@cloudflare/create-nimbus-docs": patch
---

Remove the deprecated `baseUrl` option from generated TypeScript configuration so Nimbus sites continue to pass type checks on TypeScript 6 while preserving the `@/` import alias.
