---
"@cloudflare/nimbus-docs": patch
---

- Request field lists no longer show properties marked `readOnly` across schema alternatives, and response field lists no longer show those marked `writeOnly` across alternatives. Synthesized examples use the selected alternative; authored examples retain their values. Webhook payloads read like responses. Cite a `readOnly` field under the response.
- A string example under a non-JSON media type such as `application/x-ndjson` is sent verbatim in generated samples.
- Object form examples with media-type parameters such as `; charset=utf-8` generate per-field samples; authored encoded strings keep their bytes.
