---
"@cloudflare/nimbus-docs": patch
---

`shiki.css` no longer keeps code styles from earlier releases when CI keeps `.nimbus/cache` between builds. The first build after upgrading prepares every API version again.
