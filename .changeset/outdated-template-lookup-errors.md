---
"@cloudflare/nimbus-docs": patch
---

When GitHub refuses the template lookup in `nimbus-docs outdated` or `diff`, the error now explains how to fix it: set `GIGET_AUTH` to a GitHub token, or skip the lookup with `--to` or `--template-dir`. It also says when GitHub's rate limit resets, or quotes GitHub's reason. The CLI help now mentions `GIGET_AUTH`.
