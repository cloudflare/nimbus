---
"@cloudflare/nimbus-docs": patch
---

- API pages carry each security scheme's `x-displayName` and `description`, and Markdown names a scheme by its display name with its key beside it.
- A parameter whose schema is marked `deprecated` shows as deprecated.
- An image in a description with no source, or a source the sanitizer drops (such as `cid:`), shows as the text that was written instead of an empty image.
