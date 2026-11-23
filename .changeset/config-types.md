---
"@cloudflare/nimbus-docs": patch
---

- `defineConfig()` reports a key Nimbus doesn't know, such as a typo in `features`, as a type error instead of failing the build.
- `nimbus(config, { markdown: { processor } })` types `processor` as an Astro Markdown processor.
