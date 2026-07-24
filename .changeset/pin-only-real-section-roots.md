---
"@cloudflare/nimbus-docs": patch
---

Fix overview-leaf reordering a flat top-level sidebar per page

In `indexDisplay: "overview-leaf"` mode, the section-root pin relabelled and moved any top-level link whose slug matched the current section — including standalone top-level pages with no content beneath them. On a flat top-level of single pages, that pulled the current page to the front and renamed it "Overview" on every page. Pinning now requires the section to actually have content under it, so standalone pages stay put and keep their label.
