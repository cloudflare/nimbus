---
"@cloudflare/nimbus-docs": patch
---

- A redirect whose path holds a space or line break is written to `_redirects` percent-encoded, as one rule.
- A partial build's relocated sitemap index stays valid XML when its prefix holds `&`, `<` or `>`.
