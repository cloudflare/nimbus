---
"@cloudflare/nimbus-docs": patch
---

When an API's spec can't be published because a `$ref` isn't a reference string, the build warning names where it is instead of printing `[object Object]`.
