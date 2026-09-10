---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

Render MDX admonitions using Sätteri's native directive parser and AST plugins.
Replace the Vite delimiter scanner and body reindentation with directive-to-Aside
mapping. Preserve plain titles, aliases, scoped opt-outs and opening-line body
compatibility. Nested directives follow Sätteri's native fence grammar.

Protect literal examples and parser-owned inline code and reference definitions.
Standalone-CR files stay literal pending native parser support. Markdown and
custom processors retain their own rendering paths; no remark fallback is added.
Aside and its public contract remain unchanged. Directive titles follow native
MDX syntax; use the direct Aside string prop for text that is not valid MDX.
Caller-owned processor settings and opted-in custom directive handlers are
preserved. No new dependencies.

Use Sätteri's `markdown.mdastPlugins` and `markdown.hastPlugins` for Markdown
extensions. Keep native Astro MDX options available through `mdx`. Update the
authoring guide with native extension and rendered admonition examples.

Remove unused direct `remark-mdx` and `remark-parse` development dependencies
and their bundler entries. Retain the dependencies used by lint rules and
custom-processor compatibility tests.

Update the generated starter's agent guidance with native Sätteri extension points.

Fix link normalization for Markdown files containing HTML and MDX components
containing fenced code. Preserve literal examples and normalize static links
using the parser for each source format.
