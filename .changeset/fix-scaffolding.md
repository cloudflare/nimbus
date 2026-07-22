---
"@cloudflare/create-nimbus-docs": patch
---

Fix scaffolded starter behavior across client-side navigations and add a 404 page.

- Re-run component initializers on `astro:page-load` so interactive components (code groups, dialogs, popovers, file trees, search) keep working after ClientRouter/view-transition navigations.
- Scope the search dialog's global key handler to a module variable instead of an `<html>` attribute, preventing a duplicate `Cmd+K` handler from stacking on each navigation.
- Mark inline SVG icons with `is:inline` so they render reliably.
- Ship a default `404.astro` page in the starter.
