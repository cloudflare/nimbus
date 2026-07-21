---
"nimbus-docs": minor
---

Remove the built-in incremental-build cache

The `incrementalBuilds` option, the `partialResolver` hook, and the
`nimbus-docs clean` command are gone, along with the internal cache module
that backed them. Astro 7 owns incremental building now, and running a second
cache on top of it under `node_modules/.astro` was redundant and a
stale-serve risk.

**Breaking:** if you passed `incrementalBuilds` or `partialResolver` to
`nimbus()`, remove them — they no longer exist on `NimbusIntegrationOptions`.
No replacement is needed; a plain `astro build` is the supported path, and
Astro 7's native incremental building applies without any Nimbus opt-in.
