---
"@cloudflare/nimbus-docs": minor
---

`nimbus/internal-link` and `nimbus/image-ref` now match their `ignore: string[]` option against full glob syntax (`**`, `*`, `{a,b}`, extglobs, …) via `picomatch`, not just an exact match or a `prefix` immediately followed by `/**`. In particular, a leading any-depth wildcard like `**/llms.txt` is now supported — the previous hand-rolled matcher had no way to express that.

Existing `ignore` lists using only exact paths or `prefix/**` patterns keep working unchanged.
