---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": minor
---

A redesigned API reference:

- The API home lists every endpoint, grouped by `x-tagGroups`, with a filter; large specs load in parts as you scroll.
- Section pages list their endpoints name first, with the method and path beneath.
- The API version picker sits in the header, at every width.
- Code rail lines sit on whole pixels, with quieter line numbers; section titles are in full ink.
- The API sidebar's rows match the docs sidebar's.
- Section page operations gain `method`, `path`, `description` and `deprecated`, and the root page gains an `index` of every endpoint.
- `getApiRoot` reads an API version's root page from any route; `chunkApiIndex` and `apiIndexRows` split and flatten its index.

`nimbus-docs migrate` lists the optional steps to adopt it.
