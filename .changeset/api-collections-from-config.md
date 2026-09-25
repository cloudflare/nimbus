---
"@cloudflare/nimbus-docs": minor
---

Register API collections from the Nimbus config. `apiCollection()` now takes no arguments and reads the `api` entry whose `collection` matches its key in `src/content.config.ts`, so each spec is declared once, in the inline Nimbus config in `astro.config.ts`:

```ts
// astro.config.ts
const nimbusConfig = defineNimbusConfig({
  site: "https://example.com",
  title: "Example",
  api: [{ collection: "api", spec: "./src/api/openapi.yaml" }],
});

// src/content.config.ts
export const collections = {
  docs: defineCollection(docsCollection()),
  api: defineCollection(apiCollection()),
};
```

The `api-reference` recipe now uses this shape and no longer creates `nimbus.config.ts`, so `nimbus-docs check` validates the whole config statically and `add adapter-cloudflare` edits `rendering` in place.

A collection key with no `api` entry fails content sync, and an `api` entry without an `apiCollection()` under its key fails the build, including a key registered with another loader. Both messages name the Nimbus config and `src/content.config.ts`, and `nimbus-docs check` reports the same mismatches without building.

`apiCollection(options)` and `@cloudflare/nimbus-docs/config` are unchanged, and sites built by earlier versions of the recipe keep building with no changes. **Upgrade note:** in `astro dev`, that shape silently ignores edits to the `api` entry in `nimbus.config.ts` until a manual restart. To pick up edits automatically, move the Nimbus config back into `astro.config.ts`, delete the lookup in `src/content.config.ts`, and register the collection with `apiCollection()`. `nimbus-docs upgrade` lists these steps.

Also fixes `astro dev` after an `astro.config.*` edit, for every site: collections are re-synced when Astro restarts the dev server, so docs pages keep their partial headings and Markdown routes and `llms.txt` keep working, instead of losing prepared data until a manual restart. Spec edits keep re-indexing API pages after that restart.
