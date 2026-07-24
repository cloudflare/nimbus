---
"@cloudflare/create-nimbus-docs": patch
---

The scaffolded starter's header now matches the Nimbus site. The mobile menu (hamburger) button moved from the left of the header to the right, alongside the theme toggle. The search trigger stays reachable on mobile: it previously used `hidden sm:flex` and disappeared entirely below the `sm` breakpoint, leaving phones with no way to search — it now renders as a compact magnifying-glass icon button on small screens and expands to the full "Search ⌘K" control from `sm` up (the ⌘K hint is hidden on mobile).
