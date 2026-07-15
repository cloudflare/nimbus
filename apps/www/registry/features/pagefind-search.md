---
{
  "name": "pagefind-search",
  "type": "registry:feature",
  "title": "Pagefind search",
  "description": "Add static Pagefind indexing and the Nimbus search dialog to an existing docs site.",
  "markers": ["src/components/ui/search/SearchDialog.astro", "src/components/ui/search/providers/pagefind.ts"]
}
---

# Pagefind search

You are helping the user add Nimbus's Pagefind-backed search UI to an existing Nimbus docs site.

Read this entire file before changing code.

## What to add

Install or copy the search UI folder from the canonical starter:

- `src/components/ui/search/SearchTrigger.astro`
- `src/components/ui/search/SearchDialog.astro`
- `src/components/ui/search/search.client.ts`
- `src/components/ui/search/providers/pagefind.ts`
- `src/components/ui/search/index.ts`

Add `pagefind` as a dev dependency.

Then wire the UI:

- `Header.astro` imports `SearchTrigger` and renders it when `config.search !== false`.
- `BaseLayout.astro` (or the user's top-level layout) imports `SearchDialog` and renders it once when `config.search !== false`.

Do not add a separate Pagefind integration in `astro.config.ts`. The Nimbus integration runs Pagefind after `astro build` by default. To disable it, set `search: false` in `defineNimbusConfig(...)`. To use a custom backend, set `search: { provider: "custom" }` and swap the provider import in `SearchDialog.astro`.

## Verification

Run the user's build command. Confirm:

- `dist/pagefind/pagefind.js` exists when `search` is absent or `{ provider: "pagefind" }`.
- The header renders a Search trigger.
- Cmd/Ctrl+K opens the dialog.
- A known query returns results in a built/previewed site.
- Setting `search: false` skips Pagefind and removes the UI when the user conditionals are present.

Pagefind is generated at build time. In dev mode, the dialog may show that search is only available after a production build until `astro build` has run.
