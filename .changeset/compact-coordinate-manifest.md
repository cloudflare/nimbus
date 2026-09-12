---
"@cloudflare/nimbus-docs": minor
---

Support reading both existing v1 and compact v2 API coordinate manifests.
Add an opt-in `getCompactCoordinatesManifest()` runtime helper that stores repeated
page URLs once in a single JSON file, preserving citation syntax, URLs and anchors.

Default publishing is unchanged: starter endpoints and `getCoordinatesManifest()`
still emit v1. No migration or configuration change is required.

Before opting into compact publishing, upgrade all consuming sites to a framework
release containing v2 reader support. Older readers cannot consume v2. Switch the
owned endpoint's import and call to `getCompactCoordinatesManifest()`, preserving
its headers and prerender setting. Restore `getCoordinatesManifest()` to roll back.

This does not change Astro's content store or SSR behavior.
