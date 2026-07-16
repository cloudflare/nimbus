# create-nimbus-docs

## 0.2.0

### Minor Changes

- [`bd5411f`](https://github.com/cloudflare/nimbus/commit/bd5411f30ec793709470a0a956c07c3b321bd335) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Fetch templates at scaffold time from a tag-pinned source (giget)

  The CLI no longer bundles templates in its npm tarball. Templates are downloaded
  when you scaffold, pinned to the release tag matching the CLI's own version
  (`create-nimbus-docs@0.2.0` fetches `templates-v0.2.0`) — reproducible forever,
  and old CLI versions are unaffected by new releases. Adds `--template-dir <path>`
  for fully offline scaffolding, and actionable errors for offline / missing-tag /
  rate-limited (403) fetches that name the tag tried, `GIGET_AUTH`, and
  `--template-dir`.

- [`24113e0`](https://github.com/cloudflare/nimbus/commit/24113e0aa7b999618fb7d1503ca17ba3e0cdc86b) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Clear the Node and pnpm version gates that broke a fresh scaffold

  - **Node floor raised to `>=22.12.0`.** Astro requires Node ≥ 22.12; the old
    `>=20.0.0` promise was a floor a scaffolded site could not actually build on
    (Node 20 is EOL and fails `astro build` with `Node.js v20.x is not supported
by Astro!`). CI now runs Node 24 everywhere.
  - **`pnpm install` no longer hard-fails under modern pnpm.** pnpm ≥ 10 gates
    dependency install scripts and pnpm ≥ 11 turns an ignored build into a hard
    error (`ERR_PNPM_IGNORED_BUILDS`, exit 1). Scaffolded projects now ship a
    `pnpm-workspace.yaml` that declines exactly the packages with install scripts
    — `esbuild` and `sharp` (plus `workerd` on the Cloudflare target, which pulls
    `wrangler`) — never a blanket approval. All three ship working prebuilds, so
    the site still builds while the supply-chain surface stays minimal. Verified
    green on pnpm 9, 10, 11, and npm.
