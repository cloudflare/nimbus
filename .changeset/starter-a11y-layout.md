---
"@cloudflare/nimbus-docs": patch
"@cloudflare/create-nimbus-docs": patch
---

- An `Icon` without a `title`, `aria-label` or `aria-labelledby` is hidden from screen readers.
- A Markdown table's scroll box is a region named by its caption or its column headings.
- The sidebar and table-of-contents rails follow `--nb-header-height`, and the sidebar's bottom fade shows.
- The header's section tabs no longer scroll vertically.
- Utilities on images inside `Frame` apply, so a `dark:hidden` / `hidden dark:block` pair shows one image per theme.
- The sidebar nav is named, an `Aside` with its own title is announced with its type, the mobile page menu's focus ring shows in forced colours, and prose spacing applies inside tabs.
