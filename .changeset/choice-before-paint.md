---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- The API code rail shows the reader's saved or linked code sample from the first paint, so it no longer resizes just after the page loads.
- `choiceStateScript` in `@cloudflare/nimbus-docs/runtime` shows a remembered choice among server-rendered panels before the page paints. Mark the group with `data-nb-choice` (its storage key) and optionally `data-nb-choice-param`, its panels with `data-nb-choice-panel` and optionally `data-nb-choice-kind`, and its `<select>` with `data-nb-choice-select`, then render the script right after the group.
