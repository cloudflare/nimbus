---
"@cloudflare/create-nimbus-docs": minor
"@cloudflare/nimbus-docs": minor
---

New sites start on the redesigned starter:

- A fill-in Introduction as the home page, a Writing pages guide and a Components page replace the sample pages and the landing page.
- A new type scale, steel accent, code blocks, sidebar and header logo.
- One pagination bar for the previous and next pages; with focus in the bar, `[` and `]` move between them.
- Every component part has a `data-slot` to style it by, except sidebar rows, which stay bare so large sidebars stay light.
- Components wrap long words, URLs and labels instead of overflowing on phones.
- Text meets 4.5:1 contrast in light mode, Steps are a real list, manual Tabs render one tab list and pair each tab with its panel.
- Pages mirror correctly in right-to-left languages; code stays left to right.
- On phones, sites with several sections show them as tabs under the header.
- Thin, theme-coloured scrollbars.
- `PageActions` renders extra actions passed as children; the layout passes the Copy MCP URL action that way.

Existing sites keep their look. `nimbus-docs migrate` lists optional steps to adopt it, the lighter sidebar rows, and the new favicons and asset caching. The registry adds a `variants` lib that Badge and Button install with them.
