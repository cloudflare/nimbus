---
"@cloudflare/nimbus-docs": patch
---

An API page's Markdown carries what the page shows: the fields of named and discriminator-mapped union branches, each operation's method and path on tag pages, the full request URL on operation pages, and, on the API home, every endpoint and webhook under its section. An API with more than 150 endpoints lists each section with its endpoint count instead, so its home stays readable in one go. It words them as the page does: "One of the following:", `array of X`, and `maximum: 500 · minimum: 1 · default: 50`. Nested types such as `array<array<number>>` no longer lose their brackets.

With `schemaPages: true`, a field that chooses between named schemas, such as a DNS record that is an A, MX or CNAME record, still previews them, and a named schema anywhere else in a field, such as an id-or-object field, links to its schema page instead of repeating it. Large APIs with schema pages build several times faster and smaller. Without schema pages, previews are as they were: they're the only place those fields appear.
