---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- A page can set its language and share-image alt text: `NimbusHead`, `BaseLayout` and `DocsLayout` take `locale` and `socialImageAlt`. The page's `<html lang>`, `og:locale` and JSON-LD `inLanguage` follow it, and a right-to-left language sets `dir="rtl"`, as a right-to-left `config.locale` now does on every page.
- `og:locale` is written in Open Graph's form (`en_US`) instead of as a BCP 47 tag (`en-US`), and left out when the tag has no two-letter region.
- `getPageLanguage()` in `@cloudflare/nimbus-docs/runtime` gives a page's `{ lang, dir }`.
- `HastPluginDefinition` and `HastVisitorContext` are exported from `@cloudflare/nimbus-docs/markdown`, for typing your own plugins.
