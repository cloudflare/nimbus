---
"@cloudflare/nimbus-docs": minor
---

- `/nimbus-api/coordinates.json` is now a small index, with one file per API version beside it. Publishers and the sites that cite them upgrade together.
- A site that cites another API reads only the versions it cites: the default, plus `apiReferences[].versions`.
- Builds resolve citations from each version's file directly, so an API with many coordinates no longer adds a large lookup table to the build.
