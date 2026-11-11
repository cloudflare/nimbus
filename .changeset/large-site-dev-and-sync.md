---
"@cloudflare/nimbus-docs": patch
---

- `astro dev` no longer slows down on large sites when many files change at once: a file event that changes no page copies nothing. Part of #379.
- A dev server stopped while writing its Markdown files restarts cleanly, instead of answering every request with an asset collision error.
- `astro sync` no longer renders every page to collect headings it doesn't use, so it finishes sooner on large sites.
