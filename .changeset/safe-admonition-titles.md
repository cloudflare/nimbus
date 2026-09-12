---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

Render MDX admonitions with Sätteri's native directive parser, preserving nested
content, code examples, plain titles, aliases, and scoped opt-outs. Use
`markdown.mdastPlugins` and `markdown.hastPlugins` for native extensions.
Explicit incompatible processors must disable Nimbus admonitions, while Astro
MDX options continue to pass through unchanged. Native admonitions now apply to
`.mdx` only; review existing admonition directives in `.md` files. Astro 7.2.6
or newer is required.
