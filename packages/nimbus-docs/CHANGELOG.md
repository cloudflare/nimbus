# nimbus-docs

## 0.2.1

### Patch Changes

- [#4](https://github.com/cloudflare/nimbus/pull/4) [`1ae3a78`](https://github.com/cloudflare/nimbus/commit/1ae3a78e98e4458f8ea7158627e6dd16c918bce5) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Fix three defects found by post-0.2.0

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

## 0.2.0

### Minor Changes

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
