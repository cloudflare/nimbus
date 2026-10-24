---
"@cloudflare/nimbus-docs": patch
---

Authored code samples render without `openapi-sampler` and `@readme/httpsnippet`: set `samples.generate: []` to publish authored samples only, or one warning says what to install. Authored samples highlight in every language Shiki bundles. A spec with a schema property named `$ref` builds and publishes without reference warnings, and a `$ref` whose value is not a string is reported by its location.
