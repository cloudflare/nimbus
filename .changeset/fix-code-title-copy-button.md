---
"@cloudflare/create-nimbus-docs": patch
---

Fix the code-block copy button leaking past the header border on titled blocks

On a titled code block (```` ```ts title="…" ````) the copy button — absolutely
positioned at `top: 0.5rem` and `1.75rem` tall (bottom edge at `2.25rem`) — was
taller than the `.nb-code-title` header (~`2.05rem`, which had no `min-height`),
so its bottom edge crossed the header/code border into the code area. Give the
header a `min-height` that contains the button, and fade the language badge on
hover/focus so the revealed copy button never overlaps it.
