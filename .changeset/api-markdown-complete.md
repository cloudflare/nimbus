---
"@cloudflare/nimbus-docs": patch
---

An API page's Markdown carries what the page shows: the fields of named and discriminator-mapped union branches, each operation's method and path on tag pages, the full request URL on operation pages, and, on the API home, every endpoint and webhook under its section. An API with more than 150 endpoints lists each section with its endpoint count instead, so its home stays readable in one go. It words them as the page does: "One of the following:", `array of X`, and `maximum: 500 · minimum: 1 · default: 50`. Nested types such as `array<array<number>>` no longer lose their brackets.
