---
"@cloudflare/nimbus-docs": patch
---

- `astro dev` no longer recompiles the whole content store as a module after each save, which took seconds on sites with a lot of text.
