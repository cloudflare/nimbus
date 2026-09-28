---
"@cloudflare/create-nimbus-docs": patch
---

- Templates used without the scaffolder include `nimbus.json` with the reviewed Nimbus version, so their builds no longer fail with "Nimbus has no reviewed upgrade baseline".
- New Cloudflare server sites install `@astrojs/cloudflare` 14.3, which fixes a cold-cache crash on the first `astro dev`.
- npm, yarn, and bun sites no longer include `pnpm-workspace.yaml`.
- Without a terminal, the scaffolder asks for `--yes` instead of failing with `uv_tty_init returned EINVAL`.
- The starter's `AGENT.md` points at the `Icon` component the starter uses, `@cloudflare/nimbus-docs/components/Icon.astro`, instead of `astro-icon`, and at `@cloudflare/nimbus-docs/content` for the docs schema.
- The starter's Getting Started page shows the create command.
