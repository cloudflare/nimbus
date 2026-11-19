---
"@cloudflare/nimbus-docs": patch
---

- Operations can set their URL, and tags their section segment, with `x-nimbus-route` in the spec.
- `publishCoordinates: false` leaves an API out of `/nimbus-api/coordinates.json`.
- Pages no longer bundle `routes.operations`, `routes.tagSegments` or `stripPathPrefixes`.
- APIs with `bundle: false` no longer need `apiCollection()` or `src/live.config.ts`.
- `nimbus-docs migrate` shows API upgrade reviews only to sites that have an API.
