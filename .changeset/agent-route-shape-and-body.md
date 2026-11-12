---
"@cloudflare/nimbus-docs": minor
---

- The five agent route factories take `{ body }`, a function from the text Nimbus would send to the text to send; the `ETag` and `304` are over what it returns. Use it instead of wrapping `GET` to change a document's body, which kept Nimbus's tag over its own bytes.
- The build and `nimbus-docs check` warn when a route file calls an agent factory from a shape Nimbus doesn't record, such as `src/pages/[...slug].md.ts`, naming the file to move the call to and the recorded route it may answer ahead of. A prerendered `markdownRoute()` or `markdownSourceRoute()` file at such a shape then fails the build. `migrate` carries an entry.
- The build's agent surfaces line counts the pages the Markdown routes cover: `Page Markdown: served for 12 of 340 pages`.
