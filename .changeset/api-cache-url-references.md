---
"@cloudflare/nimbus-docs": patch
---

A `$ref` to an `http(s)` URL, such as one inside an example value, no longer stops an API's prepared pages from being reused between builds. Nimbus never fetches these URLs. References to other local files still prepare the API on every build.
