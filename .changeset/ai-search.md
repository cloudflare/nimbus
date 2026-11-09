---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- Search can use a Cloudflare AI Search instance instead of Pagefind: `search: { provider: "ai-search", endpoint, instance }`.
- `nimbus-docs search sync` pushes the site's pages into the instance after a deploy.
- `nimbus-docs check` checks an AI Search setup and, with a token, compares the instance with the build.
- Builds write `_nimbus/search-corpus.json`, the list of pages any search indexer can read.
- `getPageSearchScope()` and `pageSearchScope()` give search providers a page's version.
- A search provider can return an error message for the dialog and set its own debounce.
- Browser agents can search AI Search sites through WebMCP.
