---
"@cloudflare/nimbus-docs": patch
---

- A path parameter whose example is `.` or `..` is a placeholder in code samples, which no longer request another endpoint.
- A multipart body with `=` in a field name has no cURL sample, which curl would split; the other samples stay.
