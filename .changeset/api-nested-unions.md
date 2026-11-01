---
"@cloudflare/nimbus-docs": minor
---

Union branches open in place.

- A branch that is itself a `oneOf`/`anyOf` carries its branches as `variant.union`. Inline branches keep opening as deep as the spec nests; a named union opens one level, and a named union among its branches stays a label.
- An inline object branch gets the coordinate `<base>.<position>` (`source.2`, `source.2.iban`) and shows its fields where it is declared, anchored and citable on that page.
- A named branch carries `name` and its schema's `title` beside its key `label`, and previews its properties on an operation page. Nothing in that preview is anchored, cited or printed in the Markdown version: a named schema's content belongs to its own page.
- `ApiFieldView.anchor` is now optional. It is present only on the page that owns the field, so a component renders `id={field.anchor}` with no ownership logic of its own.
- Field nesting no longer stops at six levels. A field list stops at 25,000 fields, with a warning coded `field-walk-ceiling` naming the list it cuts. Sites whose specs nest deeper render more, and their page data and Markdown versions grow accordingly.
- Sites that keep their current starter files keep working. To make inline-branch fields linkable, take the `create-nimbus-docs` starter update or drop `anchored={false}` from `ApiUnionExplorer.astro`.

Discriminator-mapped unions are unchanged.
