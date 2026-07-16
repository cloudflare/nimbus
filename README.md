# nimbus-docs — templates branch

**Do not edit. Do not open PRs against this branch.**

This is an orphan branch (no shared history with `main`). It holds nothing but
the generated Nimbus starter template variants — one directory per variant —
plus this README and LICENSE. It is written **only** by the release job
(`scripts/sync-templates-repo.mjs`) and is overwritten on every release.

- Source of truth for templates: `packages/nimbus-starter-source/` on `main`.
- Generator: `packages/create-nimbus-docs/scripts/copy-template.mjs`.
- `create-nimbus-docs` fetches the variant it needs from the immutable tag
  `templates-v<its own version>` (via giget), never from this branch directly.

Human pushes here are rejected by a branch ruleset; `templates-v*` tags are
immutable for everyone (including the bot). Make template changes on `main`.
