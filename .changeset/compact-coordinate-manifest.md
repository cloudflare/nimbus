---
"@cloudflare/nimbus-docs": minor
---

**Breaking:** API coordinate manifests now use the compact v2 format exclusively.
The existing `getCoordinatesManifest()` helper emits it by default; the endpoint,
citation syntax, page URLs and anchors are unchanged. Repeated page URLs are stored
once per namespace in a single JSON file. There is no additional helper or setting.

Upgrade publishers and consuming sites together, rebuild publishers, and refresh
checked-in manifests before rebuilding consumers. Old readers cannot consume v2,
and new readers no longer consume v1. Stage both sides before switching live sites
if uninterrupted citations are required. Local v1 references fail with rebuild
guidance; remote v1 references warn and are skipped.

Custom `CoordinatesManifest` readers must use collection `pages` and `versions`
page groups instead of the old flat `entries`. Each group has a literal `url` and
coordinate-keyed fragments: `null` means no fragment, `0` means the coordinate
itself, and a string is the exact fragment. Do not relabel old JSON as v2.

The linked upgrade-manifest entry includes rollout, verification and rollback
guidance. This changes citation transport, not Astro's content store or SSR behavior.
