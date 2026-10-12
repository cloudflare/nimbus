---
"@cloudflare/nimbus-docs": minor
---

- `sources` in the Nimbus config declares git repositories to read content from
- `docsCollection({ source })` mounts a source's folder as a collection
- `api[].spec: { source, path }` reads an OpenAPI spec from a source
- `nimbus-docs check` reads a templated source `ref` and warns on a branch or tag ref
