---
"@cloudflare/nimbus-docs": patch
---

Skip the per-page MDX partial-heading parse on pages with no `<Render>`. `mergePartialHeadings` only injects headings from `<Render>` slots, so a body without one is a pure pass-through — the `mdxToMdast` parse is now skipped for it (byte-identical output; ~4,900 of ~6,700 docs pages on cloudflare-docs).
