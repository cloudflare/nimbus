---
"@cloudflare/nimbus-docs": patch
---

CLI hints now print a runnable, scoped invocation instead of the bare `nimbus-docs` binary. Error messages, install hints, and `--help` reference `pnpm dlx @cloudflare/nimbus-docs …` (matched to your package manager — `npx` / `yarn dlx` / `bunx`), so a first-run `dlx`/`npx` user can copy-paste them, and they never resolve the unrelated legacy _unscoped_ `nimbus-docs` package on npm. For example, an unknown slug now suggests `pnpm dlx @cloudflare/nimbus-docs list` rather than `nimbus-docs list`. Once `@cloudflare/nimbus-docs` is a project dependency you can still call the `nimbus-docs` bin directly (via `pnpm exec` or an npm script) — `--help` documents both. The "framework is behind" nudge from `outdated` now suggests your package manager's update command instead of a hardcoded `npm update`.
