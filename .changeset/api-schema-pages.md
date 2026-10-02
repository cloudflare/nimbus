---
"@cloudflare/nimbus-docs": minor
---

**Breaking:** API references no longer publish a page for each `components/schemas` entry. To keep schema pages, add `schemaPages: true` to the `api` entry; that restores today's output exactly.

With schema pages off (the new default), schemas still shape operation pages, including the properties previewed under each union variant, but get no page, Markdown version, OG image, sitemap, search, or `llms.txt` entry, or citation coordinate. Union variants, discriminator mappings, and `map<Name>` types render as text. A citation in your content to a schema or schema field fails the build and names the setting. Schema names still claim their `schemas/<Name>` routes, so turning pages on can't collide with an operation. On a 400-operation slice of a large public spec, this cut output files by 60% and build time by more than half.

`getApiPageProps` now throws for a coordinate that has no page, such as a schema with schema pages off or an `x-tagGroups` category, instead of returning the API root's URLs as if they were its own.
