---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- Add `bundle: false` to an `api` entry to serve a very large or many-version API from static assets instead of the server bundle. Unchanged pages are shared across versions, and unchanged versions aren't prepared again on rebuild. The build suggests it when an API's bundled page data passes 16 MiB.
- Add `getVersionSwitchUrl` and `getApiVersionHead` for version pickers and heads in every rendering mode; the starter's picker and API layout use them.
