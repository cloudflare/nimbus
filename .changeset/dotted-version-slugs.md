---
"@cloudflare/nimbus-docs": patch
---

Support dotted version slugs such as `v1.2`. Links to a dotted version root now keep their trailing slash (`/v1.2/`, not `/v1.2`) in the sidebar, breadcrumbs, version picker, alternate links, and `IndexedEntry.url`; before, the last segment was read as a file extension. `src/content.config.ts` keys such as `"docs-v1.2"` are now recognized, so Nimbus no longer warns that collections can't be identified statically and keeps its collection checks on.
