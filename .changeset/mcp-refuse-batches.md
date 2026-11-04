---
"@cloudflare/nimbus-docs": patch
---

The remote MCP server refuses a JSON-RPC batch with one `400` error instead of running up to 100 calls; send one message per request.
