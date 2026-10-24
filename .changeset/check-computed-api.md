---
"@cloudflare/nimbus-docs": patch
---

`nimbus-docs check` no longer asks for `rendering.collections` when the `api` config is computed. It takes a zero-argument `apiCollection()` registration as an API collection, skips matching registrations against `api` entries, and says so in a "needs a build" note; the build enforces both.
