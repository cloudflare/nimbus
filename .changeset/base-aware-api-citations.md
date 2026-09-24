---
"@cloudflare/nimbus-docs": patch
---

Prose `api.ref:` citations now resolve correctly in HTML output:

- They include the site's base path. On a site with `base: "/docs"`, `[change status](api.ref:api:changeWidgetStatus)` now links to `/docs/api/...` instead of `/api/...`, matching the Markdown alternate and `llms-full.txt`.
- Citations in `.md` pages now resolve. Previously they rendered as raw `api.ref:` links; only `.mdx` pages were resolved.
- Citations resolve when the project directory is reached through a symlink.
