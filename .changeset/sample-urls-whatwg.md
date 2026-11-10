---
"@cloudflare/nimbus-docs": patch
---

- Generated sample URLs are written as browsers send them: a default port such as `:443` is dropped, IP shorthand is expanded, a server URL's own query is kept as written, and query parameters keep the spec's order.
- A TypeScript sample's options object wraps when its whole line passes 80 characters.
- A sample with both a `Cookie` header and a cookie API key sends both cookies in one header, in every language.
