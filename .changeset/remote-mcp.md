---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- `agents: { mcp: true }` serves a remote MCP server at `/mcp` with `list_pages` and `get_page` over the published Markdown, plus a Server Card at `/mcp/server-card`, a line in `llms.txt` and an entry in the AI catalog. It needs a server adapter and `@modelcontextprotocol/server`; `nimbus-docs check` reports a missing SDK.
- The starter shows a "Copy MCP URL" page action that copies the server URL when the server is on. On an existing site, run `nimbus-docs diff src/components/ConnectMcp.astro --apply` and `nimbus-docs diff src/components/connect-mcp.client.ts --apply`, then pass `{capabilities.mcpUrl && <ConnectMcp />}` to `<PageActions>` in `src/layouts/DocsLayout.astro`, as the Remote MCP server guide shows.
