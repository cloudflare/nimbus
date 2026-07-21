---
"create-nimbus-docs": patch
---

Templates now pin nimbus-docs 0.5.0

Scaffolds pin `nimbus-docs` at the minor they were generated against, so this
CLI re-releases to ship templates on 0.5.0 — which drops the built-in
incremental-build cache (the `incrementalBuilds` option, the `partialResolver`
hook, and `nimbus-docs clean`). New scaffolds use a plain `astro build`; Astro
7's native incremental building applies without any Nimbus opt-in.
