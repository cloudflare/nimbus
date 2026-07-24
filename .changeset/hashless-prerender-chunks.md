---
"@cloudflare/nimbus-docs": patch
---

Skip hashing Astro's temporary prerender bundle to speed up large builds. Astro imports that bundle to render the static pages and then deletes it, so hashing its thousands of lazy content chunks is wasted work — Rolldown re-walks the transitive chunk graph once per hash placeholder. The integration now gives those throwaway JS chunks deterministic, hashless names in the prerender environment only; shipped client and asset hashes are unchanged. On the Cloudflare Docs build (~8.7k pages) an isolated A/B measured ~30% less wall time (7:44 → 5:24). The override writes Astro 7's native `rolldownOptions` key and stays out of the way entirely if a consumer has configured the prerender environment's output themselves.
