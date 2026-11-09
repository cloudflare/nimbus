---
"@cloudflare/nimbus-docs": minor
---

- Agent surfaces follow the site's route files: delete `src/pages/[...slug]/index.md.ts` and no page Markdown is built, linked, advertised or negotiated; the same goes for the `.mdx` source, `llms.txt`, the section indexes and `llms-full.txt`, each by its own route. A Markdown route that covers part of the site publishes Markdown for that part only.
- `IndexedEntry.markdownUrl` and the page helpers' `markdownUrl` are `undefined`, and `getCollectionLlmsUrl()` returns `null`, when no route serves them.
- The MCP server reads every page whether or not its Markdown is published; `list_pages` and `get_page` return `markdownUrl` only when it is, and `get_page` takes an `offset` to read on from a cut.
- The build log and `nimbus-docs check` (`nimbus/agent-surfaces`) say which surfaces the routes serve.
