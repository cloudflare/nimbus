---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- An API page's Authorization section shows each scheme's header example and scopes again, and names HTTP Bearer and Basic schemes (`Authorization: Bearer <token>`); its Markdown names the scheme too.
- `ApiAuthView` has an optional `httpScheme`, the HTTP scheme lowercased (`bearer`, `basic`).
