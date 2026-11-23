---
"@cloudflare/nimbus-docs": patch
---

- A source can be one file at a URL: `sources: { name: { url, integrity } }`, read with `api[].spec: { source }`.
- `nimbus(config, { api: { <collection>: { transform } } })` prepares a spec in Node before Nimbus reads it.
