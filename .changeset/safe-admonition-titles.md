---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

Render MDX admonitions with Sätteri's native directive parser, preserving nested
content, code examples, aliases, and scoped opt-outs. Support safe inline formatting
in titles through an optional `title-content` slot while retaining the plain
`title` prop for existing Aside components. Fix link normalization around HTML and
MDX components containing fenced code. Use Sätteri's `markdown.mdastPlugins` and
`markdown.hastPlugins` for Markdown extensions, with native Astro MDX options
available through `mdx`. Update the starter Aside, authoring documentation, and
generated agent guidance with these conventions and the component edit needed to
enable formatted titles in existing projects, and remove unused parser dependencies.
