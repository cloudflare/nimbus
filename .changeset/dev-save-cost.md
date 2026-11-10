---
"@cloudflare/nimbus-docs": patch
---

- Saving a page in `astro dev` no longer reloads every module of the site or renders every page's Markdown again, so large sites answer the next request much sooner.
