---
"@cloudflare/create-nimbus-docs": patch
---

Markdown tables in the scaffolded starter now round their outer corner cells to match the table's `0.75rem` border-radius. Because the table uses `border-collapse: separate`, the corner cell backgrounds — most visibly the muted `<thead>` fill — previously kept square corners that poked past the rounded table border. The first/last `<th>` in the header and the first/last `<td>` in the last body row now carry the matching `border-top-left`/`border-top-right`/`border-bottom-left`/`border-bottom-right` radius, so the fill clips cleanly to the border. Scoped to `:not([class])` authored markdown tables, so component-owned tables are untouched.
