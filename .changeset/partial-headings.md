---
"@cloudflare/nimbus-docs": patch
---

Merge partial headings into the parent page's TOC. `<Render file="..." />`
partials that contain literal markdown headings (`## Foo`) now contribute
those headings to the parent page's "On this page" table of contents, in
document order, recursively. Pass `partialHeadings: { resolvePartialId }`
to `getDocsPageProps()` / `getCollectionPageProps()` to customise how
`<Render>` attributes map to a partial collection id (e.g. cloudflare-docs'
`product` convention).
