---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

Remove `llms-full.txt` and `renderLlmsFullMarkdown()`; `llmsFullRoute()` now throws with upgrade guidance. Agents use `llms.txt` and each page's Markdown version. Delete `src/pages/llms-full.txt.ts` when upgrading (review entry `llms-full-removed`).
