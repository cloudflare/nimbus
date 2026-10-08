---
"@cloudflare/nimbus-docs": patch
---

For methods that support request bodies, preserve JSON `null` in generated TypeScript and
Python samples. They now send the same four-byte JSON payload as cURL instead of omitting it.
Absent request bodies remain absent, and schema-derived examples and authored code samples
keep their existing behavior.
