# @cloudflare/nimbus-docs

## 0.8.1

### Patch Changes

- [#55](https://github.com/cloudflare/nimbus/pull/55) [`a590ebd`](https://github.com/cloudflare/nimbus/commit/a590ebd85e67b52a8e4b337c5d89801c352584ab) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - CLI hints now print a runnable, scoped invocation instead of the bare `nimbus-docs` binary. Error messages, install hints, and `--help` reference `pnpm dlx @cloudflare/nimbus-docs …` (matched to your package manager — `npx` / `yarn dlx` / `bunx`), so a first-run `dlx`/`npx` user can copy-paste them, and they never resolve the unrelated legacy _unscoped_ `nimbus-docs` package on npm. For example, an unknown slug now suggests `pnpm dlx @cloudflare/nimbus-docs list` rather than `nimbus-docs list`. Once `@cloudflare/nimbus-docs` is a project dependency you can still call the `nimbus-docs` bin directly (via `pnpm exec` or an npm script) — `--help` documents both. The "framework is behind" nudge from `outdated` now suggests your package manager's update command instead of a hardcoded `npm update`.

## 0.8.0

### Minor Changes

- [#42](https://github.com/cloudflare/nimbus/pull/42) [`8e4e210`](https://github.com/cloudflare/nimbus/commit/8e4e21081a77fff3779fad559b9e82149fa97a66) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Add the ownership + upgrade loop to the `nimbus-docs` CLI:

  - **`nimbus-docs init`** — reconstruct a `nimbus.json` for a project that lacks one (scaffolded before this record existed, an existing Astro site adopting Nimbus, or a deleted record), matching installed components against the registry and marking what it can't recover.
  - **`nimbus-docs outdated`** — a read-only check across both tiers: starter files behind their `templates-v*` tag (which `git diff` can't show) and registry components whose recorded bytes differ from the registry.
  - **`nimbus-docs diff [file]`** / **`diff --apply <file>`** — review upstream/your changes to starter files, and pull a clean upstream change per file (never a merge).
  - **`nimbus-docs add <slug> --overwrite`** — re-install a component over your copy (review with `git diff`). `add` also records each install in `nimbus.json`.

  Also adds a `getRouteFlags` layout-flag helper and a CI guard for the registry tier invariants.

  **Migration — `add --yes` no longer overwrites files you own.** It now assents to prompts (dependency installs, etc.) but keeps existing files on conflict, so a bare `-y` in CI never clobbers your code. Use `--overwrite` to replace files.

  ```bash
  # before — --yes overwrote conflicting files
  nimbus-docs add card --yes

  # after — replace files explicitly
  nimbus-docs add card --overwrite
  ```

- [#34](https://github.com/cloudflare/nimbus/pull/34) [`73bbecf`](https://github.com/cloudflare/nimbus/commit/73bbecfddcd788a0eaecb3d0eb9c404b4b4a1882) Thanks [@mvvmm](https://github.com/mvvmm)! - `nimbus/internal-link` and `nimbus/image-ref` now match their `ignore: string[]` option against full glob syntax (`**`, `*`, `{a,b}`, extglobs, …) via `picomatch`, not just an exact match or a `prefix` immediately followed by `/**`. In particular, a leading any-depth wildcard like `**/llms.txt` is now supported — the previous hand-rolled matcher had no way to express that.

  Existing `ignore` lists using only exact paths or `prefix/**` patterns keep working unchanged.

## 0.7.1

### Patch Changes

- [#36](https://github.com/cloudflare/nimbus/pull/36) [`738c8a0`](https://github.com/cloudflare/nimbus/commit/738c8a090de1bd30899849c91ec07eb5a30e0645) Thanks [@mvvmm](https://github.com/mvvmm)! - Merge partial headings into the parent page's TOC. `<Render file="..." />`
  partials that contain literal markdown headings (`## Foo`) now contribute
  those headings to the parent page's "On this page" table of contents, in
  document order, recursively. Pass `partialHeadings: { resolvePartialId }`
  to `getDocsPageProps()` / `getCollectionPageProps()` to customise how
  `<Render>` attributes map to a partial collection id (e.g. cloudflare-docs'
  `product` convention).

## 0.7.0

### Minor Changes

- [#27](https://github.com/cloudflare/nimbus/pull/27) [`1ebfb6c`](https://github.com/cloudflare/nimbus/commit/1ebfb6ccb275aee75d2c39b55407dcf731e4e142) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Add `icon` to sidebar groups — an optional leading icon (astro-icon name) before the group label. Set it two ways: on a directory's `index` frontmatter (`sidebar: { group: { icon: "ph:…" } }`) or on a config `sidebar.items` group entry (`{ label, icon: "ph:…", autogenerate: … }`). Threaded through the group schema, `SidebarGroupItem` / `SidebarConfigItem` types, and the sidebar tree builder (both the content-derived and config-defined paths).

## 0.6.1

### Patch Changes

- [#22](https://github.com/cloudflare/nimbus/pull/22) [`7ec9715`](https://github.com/cloudflare/nimbus/commit/7ec9715802bda52f235f6c78ce06383a6ede365a) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Republish with npm provenance attestations. Supersedes 0.6.0 / 0.5.0, which published without provenance and before the repo was public.

## 0.6.0

### Minor Changes

- [#20](https://github.com/cloudflare/nimbus/pull/20) [`fde68eb`](https://github.com/cloudflare/nimbus/commit/fde68eb638a113495253b875dd57f0cf4a400be9) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Rename to the `@cloudflare` npm scope

  `nimbus-docs` → `@cloudflare/nimbus-docs` and `create-nimbus-docs` →
  `@cloudflare/create-nimbus-docs`. The unscoped packages are deprecated and
  receive no further releases.

  **Migration:**

  - Framework: `pnpm remove nimbus-docs && pnpm add @cloudflare/nimbus-docs`, then
    update imports — `from "nimbus-docs"` → `from "@cloudflare/nimbus-docs"`
    (every subpath follows: `/content`, `/schemas`, `/types`, `/client`,
    `/markdown`, `/react`, `/lib/pkgm`, `/components/NimbusHead.astro`). The
    `nimbus-docs` CLI bin name is unchanged.
  - Scaffolder: `pnpm create nimbus-docs` → `pnpm create @cloudflare/nimbus-docs`.

  No API, config, schema, or runtime behavior change — only the package names and
  import paths.

### Patch Changes

- [#18](https://github.com/cloudflare/nimbus/pull/18) [`24fd3b0`](https://github.com/cloudflare/nimbus/commit/24fd3b04ec184a67d4e0ee880ddab42c17ba699c) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Fix `@shikijs/types` dedup so `Code.astro` typechecks in consuming sites

  The published `dist` inlined a local copy of `@shikijs/types`'s
  `ShikiTransformer` surface instead of importing it, so `defaultCodeTransformers`
  never deduped against the `@shikijs/types` that Astro's `<Code>` uses — breaking
  `astro check` in scaffolded sites. The build now keeps `@shikijs/types` and
  `@shikijs/transformers` as external type imports in the emitted `.d.ts`, and
  `@shikijs/types` is a runtime dependency (`^4.2.0`) so the import resolves for
  consumers. No API or runtime behavior change.

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
