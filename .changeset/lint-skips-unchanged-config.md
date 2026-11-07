---
"@cloudflare/nimbus-docs": patch
---

- `lint` and `check` skip re-reading the Astro config when it hasn't changed since the last build: about 300 ms faster per `lint` run.
