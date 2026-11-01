---
"@cloudflare/create-nimbus-docs": patch
---

The starter's union explorer opens a branch that is itself a union, labels a union by its kind ("Any of the following" or "One of the following"), shows a named branch by its schema's `title` when it declares one (the field tooltip too), and anchors a field wherever the page data gives it an `anchor`, so an inline branch's fields can be linked and cited. `ApiFieldRow` and `ApiUnionExplorer` no longer take an `anchored` prop.
