---
"@cloudflare/nimbus-docs": patch
---

Add `routes.sections: "hierarchical"` so an API collection's tag pages are served at the tag hierarchy's path (`/api/zero-trust/devices/`) instead of `tags/<segment>/`, and `routes.tagSegments` to set one tag's URL segment. Opt-in under `resource-action-v2`; coordinates and operation URLs do not change.
