---
"@cloudflare/nimbus-docs": minor
---

- `sources` in the Nimbus config declares git repositories to read content from
- `docsCollection({ source })` mounts a source's folder as a collection
- `api[].spec: { source, path }` reads an OpenAPI spec from a source
- `sources.<name>.editPattern` gives a source's pages their edit link, with `{path}` and `{ref}`
- `api.ref:` citations resolve in pages from a source, and `lint` and `check` cover them
- `nimbus-docs check` reads a templated source `ref`, warns on a branch or tag ref, and on a source nothing reads
