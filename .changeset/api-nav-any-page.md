---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- `getApiNav(Astro, { collection, href })` from `@cloudflare/nimbus-docs/runtime` returns the API sidebar opened at one API page, from any route, so a site's own pages can show the same sidebar as its API pages.
- `ApiSidebarPanel` in `api-sidebar` is that sidebar as one component: the filter, the tree, groups that load when opened, and open groups and scroll kept across pages. `ApiLayout` renders it, and a page of your own renders it with `getApiNav`.
- With `sidebar: "on-demand"`, the API sidebar can live outside `ApiLayout` without failing the components check.
- A page of your own can use `DocsLayout` with just a `title`: `sidebar`, `headings`, `breadcrumbs` and `prevNext` are optional.
