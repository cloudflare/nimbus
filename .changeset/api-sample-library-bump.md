---
"@cloudflare/create-nimbus-docs": patch
---

`nimbus-docs add api-layout` installs openapi-sampler 1.7.6 and @readme/httpsnippet 11.4.1, so generated number examples respect a bound of `0`, such as `exclusiveMinimum: 0`. Existing sites can update with `pnpm add openapi-sampler@1.7.6 @readme/httpsnippet@11.4.1`.
