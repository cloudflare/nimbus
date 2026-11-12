---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- `tryIt.testKey` is a public test key that Try it's API key and bearer token fields start with, so a reader can send a request without entering anything.
- Try it's proxy refuses a request that sets `X-Real-IP`, `True-Client-IP`, `Forwarded`, `X-Forwarded-*` or `CF-Connecting-IP`, so a caller can't pose as another address to the API.
