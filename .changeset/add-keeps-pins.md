---
"@cloudflare/nimbus-docs": patch
---

- `add` skips a dependency the site already has at the registry's version, and installs a pinned one with its exact version.
- A failed install or resolve ends with the error mark in a terminal, and prints as an error without one.
