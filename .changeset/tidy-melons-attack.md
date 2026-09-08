---
"@cloudflare/nimbus-docs": patch
---

Fix authored-link normalization failing on JSX elements whose TypeScript parse drifts from the mdast node range.

Match JSX elements by their start offset instead of their full range, skip elements without `href` attributes before the TypeScript round-trip, and reconcile attributes by name instead of index. This stops "ambiguous JSX range"/"ambiguous JSX attributes" failures on multi-line elements whose children contain JSX-like tokens (for example `{` inside a code block) or whose raw slice spans blockquote markers.
