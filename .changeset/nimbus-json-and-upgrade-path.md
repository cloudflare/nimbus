---
"@cloudflare/nimbus-docs": patch
---

Add the ownership + upgrade loop to the `nimbus-docs` CLI:

- **`nimbus-docs init`** — reconstruct a `nimbus.json` for a project that lacks one (scaffolded before this record existed, an existing Astro site adopting Nimbus, or a deleted record), matching installed components against the registry and marking what it can't recover.
- **`nimbus-docs outdated`** — a read-only check across both tiers: starter files behind their `templates-v*` tag (which `git diff` can't show) and registry components whose recorded bytes differ from the registry.
- **`nimbus-docs diff [file]`** / **`diff --apply <file>`** — review upstream/your changes to starter files, and pull a clean upstream change per file (never a merge).
- **`nimbus-docs add <slug> --overwrite`** — re-install a component over your copy (review with `git diff`). `add` also records each install in `nimbus.json`.

**Changed:** `--yes` no longer overwrites files you own — it assents to prompts (dependency installs, etc.) but keeps existing files on conflict, so it's safe in CI. Use `--overwrite` to replace files. Also adds a `getRouteFlags` layout-flag helper and a CI guard for the registry tier invariants.
