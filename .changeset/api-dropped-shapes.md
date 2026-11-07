---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- API pages and their Markdown show fields declared beside a union, such as a DNS record's `id`, `created_on` and `meta` beside its record types: the fields first, then the options that add to them.
- Object and array-of-object parameters list their fields, as body fields do.
- A request or response body that isn't an object shows its type, and its badge names its media type instead of "JSON".
