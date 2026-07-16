---
"nimbus-docs": patch
"create-nimbus-docs": patch
---

Fix three defects found by post-0.2.0

- **Wide tables no longer overflow the page.** A table with more columns than
  the content column could fit slid under the TOC rail and forced page-level
  horizontal scroll on desktop (the old scroll fallback only applied under
  640px). A `<table>` can't both fill its column and scroll — `overflow` is
  ignored on `display: table` — so scroll now lives on a wrapper:
  `nimbus-docs/markdown` exports a `tableScroll()` hast plugin that wraps
  class-less tables in a `.nb-table-scroll` container, and the starter wires it
  up with matching styles. Short tables still fill the column with no dead
  space.
- **`<Badge>label</Badge>` renders its children.** The `text` prop is now
  optional and falls back to `<slot />`; previously a slotted label was
  silently dropped and the badge rendered empty.
- **`nimbus-docs add` no longer crashes in non-TTY environments.** A file
  conflict without `--yes` in CI, a pipe, or an agent crashed with a raw
  `uv_tty_init returned EINVAL` trace when the overwrite prompt tried to open a
  TTY that wasn't there. It now detects non-interactive stdin and exits with an
  actionable message pointing at `--yes`.
