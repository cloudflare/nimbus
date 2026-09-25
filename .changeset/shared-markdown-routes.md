---
"@cloudflare/nimbus-docs": minor
---

Serve the Markdown and source versions of every collection from two route files. `markdownRoute()` and `markdownSourceRoute()` from `@cloudflare/nimbus-docs/agent-endpoints` return `{ GET, getStaticPaths }`:

```ts
// src/pages/[...slug]/index.md.ts
import { markdownRoute } from "@cloudflare/nimbus-docs/agent-endpoints";

export const prerender = true;
export const { GET, getStaticPaths } = markdownRoute();
```

- One shared route serves every collection's `/<page>/index.md`, including docs versions and API reference pages. `markdownSourceRoute()` serves `/<page>/index.mdx` for every authored page. Collections added later need no new route files.
- A more specific route file, such as `src/pages/changelog/[...slug]/index.md.ts`, takes over its collection. The shared route skips every URL that route matches, so Astro reports no route conflicts. If the more specific route doesn't generate every page it matches, the build warns and names the missing paths, or fails when `prerenderConflictBehavior` is `"error"`.
- The shared routes must be prerendered. The build fails if a route using `markdownRoute()` or `markdownSourceRoute()` is rendered on request.
- API pages now have baked Markdown assets, so `getMarkdownStaticPaths({ collection: "<api>" })` returns their entries. Hidden API versions are excluded, like hidden docs versions.

Existing per-collection routes keep working and need no change. Sites that delete the `api-reference` recipe's `src/pages/<api>/[...slug]/index.md.ts` no longer publish Markdown for hidden API versions. The `shared-markdown-routes` upgrade entry explains how to remove unmodified per-collection routes.
