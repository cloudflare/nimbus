---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

New sites' `DocsLayout` and `ApiLayout` put the page's content before the sidebar in the HTML, so agents and text readers reach it first; pages look the same. The page actions row is a `<nav aria-label="Page actions">`, and the API union explorer's "View X schema →" link, which repeats the branch name's link, is marked `data-markdown-ignore`. `nimbus-docs migrate` lists them for existing sites as optional.
