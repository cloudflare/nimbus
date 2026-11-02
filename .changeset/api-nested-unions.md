---
"@cloudflare/nimbus-docs": patch
---

API pages show every union branch. Inline branches open with their fields at `<base>.<position>` (`source.2.iban`), anchored and citable. A branch that is itself a union carries `variant.union`, and a named branch carries `name` and `title` beside `label`. Field nesting no longer stops at six levels; a list stops at 25,000 fields with a build warning. `x-nimbus-order` on an operation orders its section.

`ApiFieldView.anchor` is now optional: it is set only on the page that owns the field, so render `id={field.anchor}`. A custom component that requires a `string` needs updating.
