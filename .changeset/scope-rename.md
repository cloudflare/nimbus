---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": minor
---

Rename to the `@cloudflare` npm scope

`nimbus-docs` → `@cloudflare/nimbus-docs` and `create-nimbus-docs` →
`@cloudflare/create-nimbus-docs`. The unscoped packages are deprecated and
receive no further releases.

**Migration:**

- Framework: `pnpm remove nimbus-docs && pnpm add @cloudflare/nimbus-docs`, then
  update imports — `from "nimbus-docs"` → `from "@cloudflare/nimbus-docs"`
  (every subpath follows: `/content`, `/schemas`, `/types`, `/client`,
  `/markdown`, `/react`, `/lib/pkgm`, `/components/NimbusHead.astro`). The
  `nimbus-docs` CLI bin name is unchanged.
- Scaffolder: `pnpm create nimbus-docs` → `pnpm create @cloudflare/nimbus-docs`.

No API, config, schema, or runtime behavior change — only the package names and
import paths.
