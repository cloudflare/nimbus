---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

Nimbus serves `/nimbus-api/coordinates.json` itself, with the same JSON and headers, so new sites have no `src/pages/nimbus-api/coordinates.json.ts`. An existing site's file keeps serving the path and wins; `nimbus-docs check` says when it's the starter's unchanged copy, which can be deleted.
