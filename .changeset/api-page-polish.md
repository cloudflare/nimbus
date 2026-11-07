---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- On wide screens an API page's code rail fits the viewport: its header stays put and a long sample scrolls both ways with both scrollbars in view. Code you can scroll gets a focus ring.
- The endpoint box cuts the server address before the path, so the path stays visible.
- Spec descriptions get spaced headings and inline-code chips.
- On wide screens the previous/next bar spans the body and the code rail.
- A field with more than six allowed values lists every one on an "Allowed values" line, instead of behind a hover tooltip.
- Request body and Returns have anchors (`#request-body`, `#responses`), and every API section heading gets a "#" link. `headingAnchors()` also links headings inside any `data-nb-heading-anchors` container.
- CodeGroup's copy button comes before its code in Tab order.
- Every keyboard shortcut lives in `src/lib/shortcuts.ts`: change a key or set it to `false` to remove it. `[` and `]` go to the previous and next page from anywhere on the page, and readers can turn single-key shortcuts off from the search dialog. `onShortcut`, `syncShortcutHints`, the key labels and the reader's switch are in `@cloudflare/nimbus-docs/client`.
- A `Switch` component (`nimbus-docs add switch`): an on/off control. The shortcuts switch in the search dialog uses it.
