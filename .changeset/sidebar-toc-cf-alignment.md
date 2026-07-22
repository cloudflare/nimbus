---
"@cloudflare/create-nimbus-docs": minor
---

Align the sidebar + add a mobile "On this page" TOC matching cloudflare-docs, and tighten the docs layout's mobile and horizontal-overflow handling.

- **Sidebar + TOC:** the sidebar filter gains a `press / to focus` kbd hint and a `placeholder` prop; sidebar groups render an optional leading icon (from `sidebar.group.icon`); and a sticky native-`<select>` "On this page" TOC now appears under the page title on viewports below `xl`, where the desktop TOC rail hides.
- **Mobile sidebar drawer:** the drawer no longer dims or blurs the page — it slides in over a transparent overlay so the page copy stays readable, with a hairline edge instead of a shadow. Both the drawer panel and the desktop sidebar now paint their own background and contain overscroll, fixing a "no background" flash on fast/momentum scroll.
- **Tabs:** a tab strip wider than its column now scrolls horizontally (scrollbar hidden) instead of leaking past the page width, and the active tab is scrolled into view on activate/restore.
- **Prose:** long unbroken tokens (URLs, hashes) wrap within the content column via `overflow-wrap: break-word` instead of overflowing the page; code blocks and wide tables keep their own scroll handling.
