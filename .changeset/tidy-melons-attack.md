---
"@cloudflare/nimbus-docs": patch
---

Fix authored-link normalization failing on JSX elements whose TypeScript parse drifts from the mdast node range.

Match JSX elements by their start offset instead of their full range, skip elements without `href` attributes before the TypeScript round-trip, and reconcile attributes by name instead of index. This stops "ambiguous JSX range"/"ambiguous JSX attributes" failures on multi-line elements whose children contain JSX-like tokens (for example `{` inside a code block) or whose raw slice spans blockquote markers.

Also skip normalization for plain `.md` files, which are not guaranteed to be valid MDX (legacy files can contain HTML comments or prose with `{key: value}`) and previously failed the build on an MDX parse error.
