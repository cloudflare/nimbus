---
"@cloudflare/nimbus-docs": patch
---

Fix `@shikijs/types` dedup so `Code.astro` typechecks in consuming sites

The published `dist` inlined a local copy of `@shikijs/types`'s
`ShikiTransformer` surface instead of importing it, so `defaultCodeTransformers`
never deduped against the `@shikijs/types` that Astro's `<Code>` uses — breaking
`astro check` in scaffolded sites. The build now keeps `@shikijs/types` and
`@shikijs/transformers` as external type imports in the emitted `.d.ts`, and
`@shikijs/types` is a runtime dependency (`^4.2.0`) so the import resolves for
consumers. No API or runtime behavior change.
