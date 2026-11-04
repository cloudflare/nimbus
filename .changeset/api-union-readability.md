---
"@cloudflare/nimbus-docs": patch
---

API pages and their Markdown read union branches more clearly:

- An untitled branch that is itself a union is labelled `Option N`.
- An inline scalar branch shows its literals and description.
- A discriminator union lists the branches no mapping value selects.
- A field typed as a named union, or where a self-reference stops, shows the schema's name (linked when it has a page).
