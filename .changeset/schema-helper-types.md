---
"@cloudflare/nimbus-docs": patch
---

- `entry.data` keeps its field types with `docsCollection()` and `partialsCollection()` without `schemaFields`, `docsSchema`, `defineDocSchema()` and `definePartialsSchema()` without `fields`, and `defineSchema()`. `astro check` may now report mistakes these were hiding.
- `partialsCollection({ schemaFields })` types the declared fields.
