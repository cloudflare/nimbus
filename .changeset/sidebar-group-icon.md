---
"@cloudflare/nimbus-docs": minor
---

Add `icon` to sidebar groups — an optional leading icon (astro-icon name) before the group label. Set it two ways: on a directory's `index` frontmatter (`sidebar: { group: { icon: "ph:…" } }`) or on a config `sidebar.items` group entry (`{ label, icon: "ph:…", autogenerate: … }`). Threaded through the group schema, `SidebarGroupItem` / `SidebarConfigItem` types, and the sidebar tree builder (both the content-derived and config-defined paths).
