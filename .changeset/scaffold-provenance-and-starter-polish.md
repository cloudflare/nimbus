---
"@cloudflare/create-nimbus-docs": patch
---

Scaffolded projects now include a committed `nimbus.json` — a CLI-managed record of the `create-nimbus-docs` version, the `templates-v*` tag, the install root, and (as you `nimbus-docs add`) each installed component's provenance. Starter components also get an API-consistency pass: `type`→`variant` on Banner/Callout, `VersionPicker`→`VersionSwitcher`, hydration moved out of inline scripts into `.client.ts` files via the `mount()` primitive, and a single `getRouteFlags` layout-flag helper. The scaffolded `AGENT.md` now documents the `outdated` / `diff` / `add --overwrite` upgrade flow.
