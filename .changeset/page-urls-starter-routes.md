---
"@cloudflare/create-nimbus-docs": patch
---

The starter's page route takes `markdownUrl` and `ogImageUrl` from `getDocsPage()`, its OG route builds cards from `getOgImagePages()`, and its three `llms.txt` routes call `llmsRoute()`, `llmsFullRoute()`, and `llmsSectionRoute()`. `src/utils/agent-endpoint-response.ts` is removed. Built output is unchanged.
