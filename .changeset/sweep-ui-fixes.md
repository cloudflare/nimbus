---
"@cloudflare/create-nimbus-docs": patch
---

Fix a batch of UI stress-sweep defects in the starter components:

- **TOC scroll-spy** no longer desyncs when a heading slugs to an empty id (e.g. an emoji-only `## 🎉`). The active-heading index now stays aligned with the full link/rail set instead of a resolvable-only subset, so every section below an unresolvable heading highlights correctly.
- **Mobile sidebar** hamburger survives client-side navigation — the toggle re-binds on `astro:page-load` and tears down on `astro:before-swap` (via `mount()`), fixing a dead button after the first view transition, with the scroll lock balanced on a mid-open swap.
- **Dialog** content taller than the cap now scrolls inside the panel (`overflow-y-auto`) so the close button stays reachable.
- **Banner** long unbroken strings (including the framework deprecation banner's version URL) wrap instead of overflowing.
- **PackageManagers** blocks with identical props on one page now get unique, incremental-build-stable DOM ids (per-page counter), fixing duplicate `id`/`aria-controls`.
- Dev-only warnings: `<Steps>` around a bullet list, and duplicate labels within a `<Tabs syncKey>` group.
