---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

Render MDX admonitions with Sätteri's native directive parser, preserving nested
content, code examples, plain titles, aliases, and scoped opt-outs. Fix link
normalization around HTML and MDX components containing fenced code. Use Sätteri's
`markdown.mdastPlugins` and `markdown.hastPlugins` for Markdown extensions, with
native Astro MDX options available through `mdx`. Update the authoring documentation
and generated agent guidance, and remove unused parser dependencies.
