# create-nimbus-docs

## 0.3.0

### Minor Changes

- [#9](https://github.com/cloudflare/nimbus/pull/9) [`d83ef06`](https://github.com/cloudflare/nimbus/commit/d83ef0620863f976510d299f58658151f9378a36) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Ship the static agent-surface layer: full corpus, raw-source twins, version labels

  - **`/llms-full.txt`** — the whole published site as one deterministic
    markdown document, via the new `renderCorpusMarkdown()` helper behind a
    ten-line starter route. Scope matches the root `llms.txt` (primary +
    secondary collections, non-current doc versions excluded); collation is
    sorted and timestamp-free, so output is byte-identical across rebuilds.
    `/llms.txt` links to it.
  - **Raw-source twin at `<page>/index.mdx`** — the authored MDX body served
    verbatim with the same canonical frontmatter block as the `.md` twin.
    Twin grammar: `index.md` is the downleveled render for reading,
    `index.mdx` is the source. The `.md` twin's `Source:` line now points at
    the `.mdx` twin instead of itself.
  - **`IndexedEntry` gains `sourceUrl`** (site-relative URL of the raw-source
    twin; `undefined` for entries without a string body) **and `version`**
    (the entry's version label resolved from the `versions` manifest;
    `undefined` on unversioned sites and non-docs collections). On versioned
    sites every twin's frontmatter carries a `version:` label so agents can
    pin a version; unversioned sites are byte-for-byte unchanged.
  - **`astro` peer range is now `>=6.4.0 <7.0.0`**, declaring the Astro 6
    requirement that `@astrojs/mdx@6` always implied. Astro 7 support lands
    as its own release.

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
