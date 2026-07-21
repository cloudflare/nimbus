# @cloudflare/nimbus-docs

## 0.5.0

### Minor Changes

- [#16](https://github.com/cloudflare/nimbus/pull/16) [`4abd409`](https://github.com/cloudflare/nimbus/commit/4abd4096a4437b9d7b0428d4aeec254d4e50d708) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Remove the built-in incremental-build cache

  The `incrementalBuilds` option, the `partialResolver` hook, and the
  `nimbus-docs clean` command are gone, along with the internal cache module
  that backed them. Astro 7 owns incremental building now, and running a second
  cache on top of it under `node_modules/.astro` was redundant and a
  stale-serve risk.

  **Breaking:** if you passed `incrementalBuilds` or `partialResolver` to
  `nimbus()`, remove them — they no longer exist on `NimbusIntegrationOptions`.
  No replacement is needed; a plain `astro build` is the supported path, and
  Astro 7's native incremental building applies without any Nimbus opt-in.

## 0.4.0

### Minor Changes

- [#13](https://github.com/cloudflare/nimbus/pull/13) [`456ca74`](https://github.com/cloudflare/nimbus/commit/456ca74bd6442b94d272d2e114a8be81211a73cd) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Move to Astro 7

  `nimbus-docs` now peers on `astro ^7.0.0` (was `>=6.4.0 <7.0.0`) and builds
  against the Astro 7 ecosystem: `@astrojs/mdx ^7`, `@astrojs/markdown-satteri
^0.3.4` (Sätteri `^0.9`), Vite 8. The markdown pipeline — Sätteri plus the
  `hastPlugins`/`mdastPlugins` seam and Shiki dual-theme output — is unchanged;
  the Sätteri `0.6→0.9` jump left the plugin-definition types intact, so no
  seam code moved.

  Astro 7 makes Sätteri the default processor, which unblocks opt-in server
  output alongside it (the gate for hosted MCP, Ask AI, and content
  negotiation).

  **Starter templates**: Tailwind v4 now wires through `@tailwindcss/vite`
  instead of the PostCSS plugin, which does not build under Astro 7's Vite 8
  bundler. Scaffolded projects gain `@tailwindcss/vite` and drop
  `@tailwindcss/postcss` + `postcss.config.mjs`.

  **Breaking (peer)**: sites must be on Astro 7. The `unified()` escape hatch
  for remark/rehype plugins still works, but `@astrojs/markdown-remark` must
  now be installed explicitly (`pnpm add @astrojs/markdown-remark`) — pnpm does
  not expose it for import even though `@astrojs/mdx` pulls it transitively.

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

## 0.2.2

### Patch Changes

- [#7](https://github.com/cloudflare/nimbus/pull/7) [`692bd5e`](https://github.com/cloudflare/nimbus/commit/692bd5e042e321349664592673a82feb15df96ae) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Fix `sidebar.isolate` collapsing the rail when a page links out of the boundary

  When `sidebar.isolate.boundaries` was configured (e.g. `["learning-paths/*"]`),
  a single page inside the boundary group that linked **out** of the boundary's
  URL subtree — a relative cross-section `external_link` — made `isolateToBoundary`
  discard the module containing it (and its parent boundary group) and fall through
  to the first fully-in-prefix group in DFS order. Every page under that learning
  path then rendered the wrong rail: a sibling module (or a clean nested subfolder)
  flattened, or — under a multi-segment glob — the rail silently left unisolated.

  The boundary group is now identified positively instead of by "all descendants
  under the prefix." Groups are stamped at build time with the URL subtree they
  own (`_routeKey`): an autogenerate group's directory path, a non-primary
  collection mount, or a manual group's `segment`. `isolateToBoundary` selects
  the stamped group whose key equals the glob-implied prefix **and** which
  contains the current page (via the existing `containsRouteKey`, already robust
  to `_neverActive` links and `_indexNeverActive`/external landings).
  `flattenSidebar` is unchanged, so `getPrevNext` pagination is unaffected.

  Behavior notes:

  - Selection now pins to the glob-implied depth. On the rare nested-wrapper
    single-path tree — where the previous code isolated at whatever wrapper
    happened to be fully in-prefix — the isolated rail now sits at the glob depth
    instead. This aligns single- and multi-path trees, which previously diverged.
  - A group must declare the URL subtree it owns to be an isolate boundary
    (autogenerate `directory`, collection mount, or manual `segment`). A plain
    manual `{ items }` group with no `segment` is treated as a visual grouping
    rather than a URL boundary; if such a group previously isolated via the old
    descendant scan, add a `segment` to keep it selectable.

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
