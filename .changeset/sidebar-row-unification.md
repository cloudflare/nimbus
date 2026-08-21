---
"@cloudflare/create-nimbus-docs": minor
---

Unify the docs and API rails onto shared base components, and fix several API-reference drifts.

- Sidebar row: extract a shared `SidebarGroupHeader`; `SidebarLink` gains an optional `leading` slot. `ApiSidebar`/`ApiSidebarItem` compose these instead of re-implementing them, with the method chip as a self-scoped `ApiMethodChip` in the slot. `api-sidebar` now depends on `sidebar`.
- Align the group disclosure caret so linkable and disclosure-only headers share one column.
- API breadcrumbs render through the base `Breadcrumbs` (new `endsAtCurrentPage`, default `true`; the API rail passes `false` for its ancestors-only trail). `api-layout` now depends on `breadcrumbs`.
- The deprecated-operation notice renders through the base `Banner`. `api-layout` now depends on `banner`.
- Method colour is now single-source: the `--nb-m-*` palette lives in `globals.css`, shared by the sidebar `ApiMethodChip` and the route pill (a mono span with a leading arrow glyph). Fixes a mismatch where the pill's semantic `Badge` colours rendered GET blue / POST green — swapped from the chip.
- Fix double-spaced code-rail samples (drop the redundant `.line { display: block }`).
- `ApiFieldList` gains the `truncated` prop so capped groups show the "… N more omitted" note; `ApiLayout` forwards it.
- Align the API shell header offset with the docs layout (`top-14` / `3.5rem`); the code rail sizes from a dedicated `--nb-code-rail-width` (default `34rem`) instead of borrowing `--nb-toc-width`.
- Harden the shared mobile nav drawer: reclaim a drawer caught mid-close, wire `aria-expanded`/`aria-controls`/`aria-haspopup`, close instantly under `prefers-reduced-motion`, dismiss at the desktop breakpoint, and drop the two-frame open delay.
- Single-source the site `Header`: `brand`/`actions` slots and an optional `sections` prop replace per-app header forks, and it imports `SearchTrigger` directly so the search dialog stays out of its module graph.
- Bring the persistent sidebar in at `md` (tablet) instead of `lg` (compact `w-60` through the `md`–`lg` band), retire the hamburger at `md` in lockstep, and make the header overflow-proof (pinned logo/controls, scrollable section nav). Side-by-side code rail stays at `2xl`.
