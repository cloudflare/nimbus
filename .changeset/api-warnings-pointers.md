---
"@cloudflare/nimbus-docs": patch
---

- An `x-nimbus-order` Nimbus ignores now warns: one that isn't a number, or one anywhere but a path operation.
- API warnings and errors point at their place in the spec with JSON pointers that resolve (`#/paths/~1pets/get`).
- Each field list cut at the 25,000-field ceiling gets its own warning, naming the list.
