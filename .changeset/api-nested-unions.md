---
"@cloudflare/nimbus-docs": minor
---

Union branches open in place. A branch that is itself a `oneOf`/`anyOf` carries its branches as `variant.union`, as deep as the spec nests; an inline object branch is minted as a `variant` node at `<base>.<position>` and previews its fields where it is declared; a named branch carries its schema's `title` beside its key `label`. Field nesting no longer stops at six levels or one inline level: the walk and the page data follow the spec until a schema repeats on the current path, with a 25,000-node ceiling per field list as the backstop (a warning names the list it cuts). Sites whose specs nest deeper than six levels render more, and their page data and Markdown twins grow accordingly; the Markdown version prints nested branches and the fields of inline branches, and keeps a named branch as a label or a link. Discriminator-mapped unions are unchanged.
