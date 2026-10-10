---
"@cloudflare/nimbus-docs": patch
---

- Request field lists no longer show `readOnly` properties, and response field lists no longer show `writeOnly` ones, matching the examples. Webhook payloads read like responses. Cite a `readOnly` field under the response.
- A string example under a non-JSON media type such as `application/x-ndjson` is sent verbatim in generated samples.
- A form media type with parameters such as `; charset=utf-8` is sent field by field in generated samples.
