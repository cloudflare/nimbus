---
"@cloudflare/nimbus-docs": minor
---

Add OpenAPI-driven API reference support.

- New `api` config option (`ApiSpec[]`) mounts one or more OpenAPI 3.x specs (local file or inline object) as routed content collections.
- New `nimbus-docs/api` entry point turns a spec into a render-ready view model: `getApiModel`, `getApiPageSlugs`, `getApiPageProps` (operation/schema/section/api kinds), and `getApiNav`. Named unions, typed maps, and `allOf` are folded server-side; request/response samples are derived; descriptions render as sanitized Markdown.
- API pages join the agent surface: a per-page Markdown twin per operation, indexed into `/llms.txt`.
- Pairs with the `api-layout` registry recipe (`nimbus-docs add api-layout`) for the UI. `@scalar/openapi-parser` (required to build an API page) and the sample generators `openapi-sampler` + `@readme/httpsnippet` (optional) are optional peer deps installed by that recipe, so docs-only sites carry none.
- New `nimbus-docs/client` primitive `initDisclosureGroup` — expand/collapse-all plus hash deep-linking (auto-opens a linked field's ancestors and scrolls to it) for a group of native `<details>`, reduced-motion aware. Used by the `api-field-row` recipe's filetree field explorer.
