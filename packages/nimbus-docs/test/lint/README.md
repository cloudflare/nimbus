# Lint test harness

Tests for the `nimbus-docs lint` engine. Run with:

```sh
pnpm --filter nimbus-docs test
```

(Node's built-in test runner via `tsx`, so `.ts` runs directly — no build step.)

## Conventions

- **Inline sources** drive the precise rule/engine tests (`*.test.ts`). They
  call `parseSource()` + `lintFile()` directly — the engine is pure and
  synchronous, so a test is just "source in, `Diagnostic[]` out".
- **Fixtures** under `fixtures/` exercise discovery + collection inference
  through `findMdxFiles()` / `lintPaths()`. Naming:
  - `*.pass.mdx` — must lint clean.
  - `*.fail.mdx` — must produce at least one `error`.

When you add a rule, add both a passing and a failing case. When a rule's
output changes, the assertion — not the rule — is what gets reviewed.
