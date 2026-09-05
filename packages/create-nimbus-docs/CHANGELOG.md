# @cloudflare/create-nimbus-docs

## 0.7.1

### Patch Changes

- [#106](https://github.com/cloudflare/nimbus/pull/106) [`2c08dce`](https://github.com/cloudflare/nimbus/commit/2c08dce58a3799e59b3c408b6e273112e9189556) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Install `@cloudflare/nimbus-docs` as a runtime dependency so the CLI can load its adapter helpers.

## 0.7.0

### Minor Changes

- [#93](https://github.com/cloudflare/nimbus/pull/93) [`43c161a`](https://github.com/cloudflare/nimbus/commit/43c161a993385c9fd121c2732b0fa37a6d74175d) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Add first-party OpenAPI reference support to Nimbus.

  - Configure local or inline OpenAPI specs as routed, version-aware collections with operations, schemas, tags, webhooks, generated samples, and every declared request-body media type.
  - Install an editable `api-layout` UI that shares Nimbus's docs shell, navigation, breadcrumbs, banners, mobile behavior, and deep-linkable field and code-sample controls. The copied `ApiFieldList` field iterator is explicitly typed so the scaffolded UI type-checks cleanly under a consumer's strict TypeScript.
  - Publish per-page Markdown, agent indexes, corpus entries, coordinate manifests, and `api.ref:` citations across local and cross-site documentation.
  - Harden generated-consumer delivery with exact registry dependencies, working pnpm installs from scaffold roots, and base-aware canonical, Markdown, sitemap, and agent URLs through the new public `withBase` helper.
  - Control how operation pages are addressed, and stay resilient to messy specs. By default, operations that lack a usable `operationId` no longer abort the build — they warn and fall back to a path-derived coordinate, so real-world specs (e.g. Cloudflare's `brand-protection` operations) build; set `api[].requireOperationId: true` on specs you own to keep that fatal, while route-hostile paths and coordinate collisions stay fatal regardless. For readable, path-derived URLs, opt into the `resource-action-v1` route convention: set `api[].routes: { convention: "resource-action-v1" }` (per version in a family) to derive slugs like `charges/list` from an operation's method and path, decoupled from `operationId` so route-hostile identifiers no longer poison URLs. Trim shared bases with `stripPathPrefixes` (e.g. `["/v1"]`), pin individual pages with an `operations` (`operationId` → slug) map, and inspect how each slug resolved (`override` / `derived` / `fallback`) via the new `getApiRouteProvenance` export. Derivation collisions, reserved-route segments, unused overrides, cross-version slug drift, and unknown config keys (e.g. a `stripPrefixes` typo for `stripPathPrefixes`) are reported with pointed messages; the default (no `routes`) keeps the legacy `operationId` slugs unchanged.

- [#103](https://github.com/cloudflare/nimbus/pull/103) [`f372a4e`](https://github.com/cloudflare/nimbus/commit/f372a4eff6efa0e83706a6a9a840531b2ec0796d) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Add a `--adapter <vercel|node|netlify|cloudflare>` scaffold flag for server output.

  Passing `--adapter` selects `output: "server"` and wires the chosen adapter at scaffold time: it flips the generated `astro.config` at the `// nimbus:adapter` marker, appends the adapter's platform build dir to `.gitignore`, and for Cloudflare writes a server `wrangler.jsonc`. Node scaffolds include a production `start` script. `--deploy` is ignored with `--adapter` (server output owns its target). Config discovery follows Astro's own resolution order and supported set (`.mjs`/`.js`/`.ts`/`.mts`), matching the `nimbus-docs add adapter-*` opt-in. Copied templates are rejected if they contain symlinks so transformations cannot escape the project root.

  Static scaffolds now preserve the `// nimbus:adapter` marker so the later `nimbus-docs add adapter-*` opt-in can reliably rewrite generated projects.

  Reject destinations whose existing symlinked parent resolves outside the current directory, quote paths with spaces in next-step commands, and keep generated components compatible with adapter-defined `Astro.locals` types.

- [#104](https://github.com/cloudflare/nimbus/pull/104) [`862df4a`](https://github.com/cloudflare/nimbus/commit/862df4ac2786fbc46e0e40a5517c27f4dc39e8da) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Add Cloudflare request rendering for canonical content collections.

  Nimbus now supports collection-level build and request rendering policies with validated defaults and per-collection overrides. Request-rendered prose and API routes use response-aware page helpers, prepared API models, request-safe partial headings, 404 responses, and build-derived syntax-highlighting assets without shipping source OpenAPI specs to Workers. Cloudflare server scaffolds enable request rendering by default, and generated pnpm configuration installs Satteri's WASI fallback alongside the current architecture.

  Preserve sitemap, Pagefind, Markdown, and agent-index discovery for request-rendered routes. Pin the tested sitemap integration, clean up synthetic Pagefind staging files transactionally, and generate cross-collection Open Graph images in new starters.

### Patch Changes

- [#89](https://github.com/cloudflare/nimbus/pull/89) [`deddca5`](https://github.com/cloudflare/nimbus/commit/deddca54d0fe98f17dee0056e6b7d84159aaa808) Thanks [@sansynx](https://github.com/sansynx)! - Remove the deprecated `baseUrl` option from generated TypeScript configuration so Nimbus sites continue to pass type checks on TypeScript 6 while preserving the `@/` import alias.

- [#99](https://github.com/cloudflare/nimbus/pull/99) [`2965d9f`](https://github.com/cloudflare/nimbus/commit/2965d9ff95bc06a90dee6eaf1e7cc7383fee36e1) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Guard the `PackageManagers` restore script's `textContent` access with optional chaining so the starter passes a strict `astro check` (part of the CJK/type-safety fixes).

## 0.6.6

### Patch Changes

- [#86](https://github.com/cloudflare/nimbus/pull/86) [`b4b0dc3`](https://github.com/cloudflare/nimbus/commit/b4b0dc3b8746bd148b82eca458fbc5a1f500acd7) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Starter accessibility, layout-stability, and no-flash navigation fixes:

  - Skip link now lands focus — `<main>` gets `id="main-content"` and `tabindex="-1"` on the 404, home, and docs layouts.
  - Closed sidebar groups leave the tab order (`inert`), including the pre-hydration restore path.
  - "On this page" no longer reflows when an item becomes active (width-reserving ghost).
  - Focus rings no longer flash on first focus (base-layer outline default so the ring color/width/offset never animate).
  - Client-side navigation via `<ClientRouter />` with a blocking (`is:inline`) theme bootstrap to remove the first-paint theme flash, a page-content view transition, and a navigation-safe sidebar-state restore that keeps the active item visible.

## 0.6.5

### Patch Changes

- [#76](https://github.com/cloudflare/nimbus/pull/76) [`acfac20`](https://github.com/cloudflare/nimbus/commit/acfac2047b79711b99c586485814dd18abb3c4f9) Thanks [@mvvmm](https://github.com/mvvmm)! - Replace `astro-icon` with a built-in icon system. This is a breaking change for any project using `astro-icon` directly.

  **Why:** `astro-icon` stamped a generated `lastModified` timestamp into its virtual module on every build, invalidating thousands of cached pages in Astro's incremental build cache. The package is unmaintained so an upstream fix isn't coming.

  **What's new:** Nimbus now provides `virtual:nimbus/icons` (a Vite plugin) and `@cloudflare/nimbus-docs/components/Icon.astro`. The plugin auto-detects installed `@iconify-json/*` packages and loads local SVGs from `src/icons/`. The component API is compatible with `astro-icon` (`name`, `size`, `width`, `height`, `is:inline`, `title`, `desc`, and all `<svg>` attributes). SVG bodies are passed through `replaceIDs` so internal IDs (clipPath, mask, gradient defs) are unique per render — preventing collisions when the same icon appears more than once on a page.

  **Breaking changes:**

  - Remove `astro-icon` from your `package.json` and `astro.config.ts`
  - Replace `import { Icon } from "astro-icon/components"` with `import Icon from "@cloudflare/nimbus-docs/components/Icon.astro"`
  - SVG output structure changed: SVGs are always inlined; the previous `<symbol>`/`<use>` pattern produced duplicate DOM IDs when the same icon was used more than once on a page, so it has been removed. Any CSS or JS targeting `symbol` or `use` elements will need updating.

  **Migration:**

  ```diff
  - import { Icon } from "astro-icon/components";
  + import Icon from "@cloudflare/nimbus-docs/components/Icon.astro";
  ```

  Starter templates updated: removed `astro-icon` dependency and `icon()` integration from `astro.config.ts`; all component imports updated to the new path.

- [#70](https://github.com/cloudflare/nimbus/pull/70) [`b9620bc`](https://github.com/cloudflare/nimbus/commit/b9620bc475f9dfb0d92b6bd12c5a441d1c5bc599) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Fix search dialog results not scrolling. The results wrapper now lays out as a
  flex column, so the results list gets a bounded height and its `overflow-y-auto`
  engages — long result sets scroll within the dialog instead of being clipped,
  while the search input stays in view above the scroll region.

- [#71](https://github.com/cloudflare/nimbus/pull/71) [`4d6815f`](https://github.com/cloudflare/nimbus/commit/4d6815f3969f6a465e7549c663c579d699bd6492) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Make pkg.pr.new preview builds scaffold from bundled PR templates and pin generated projects to the matching `@cloudflare/nimbus-docs` preview.

  Generated starters are now pinned to the verified Astro 7.0.x line while the upstream Astro 7.1.x static build regression is open.

## 0.6.4

### Patch Changes

- [#64](https://github.com/cloudflare/nimbus/pull/64) [`d551fa2`](https://github.com/cloudflare/nimbus/commit/d551fa23ca3031b599654210da82a4f75685a680) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Stop shipping the `.nimbus/` build directory into scaffolded projects

  `.nimbus/` holds build artifacts materialized by `astro build` (`routes.json`, `lint.json`). It had leaked into the starter source and was being copied into new projects, so a freshly scaffolded app carried stale route and lint truth from the template rather than its own. `.nimbus` is now excluded by both the template-copy script and the runtime scaffolder, and removed from the starter source; a new project starts with no build artifacts and generates its own on first build.

- [#64](https://github.com/cloudflare/nimbus/pull/64) [`e1e4e8d`](https://github.com/cloudflare/nimbus/commit/e1e4e8d313952ffb197eb31f0a63983e93d20adc) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Point the scaffolded AGENT.md at `nimbus-docs check`

  The generated `AGENT.md` now documents the one-command model: a "Check it builds" row in the actions table (env + structure + authoring + types), and an "Audit this site" section that leads with `nimbus-docs check --json` before the manual walk of what `check` doesn't cover yet (route-file existence, registry hygiene, AI surface, post-build search, Cloudflare config).

  It teaches an agent the honest result contract: the primary signals are `status` (passed|failed|partial) and `readiness` (buildable|blocked|unknown), with `ok` kept only for back-compat; a check that couldn't be evaluated yet (e.g. types before a build) is a `note` under `scopes[].notes[]` — never a finding, never a `fix` — so the fix loop terminates on `status !== "failed" && summary.fixable === 0` rather than spinning on a coverage gap it cannot repair.

## 0.6.3

### Patch Changes

- [#55](https://github.com/cloudflare/nimbus/pull/55) [`a986d61`](https://github.com/cloudflare/nimbus/commit/a986d61f1511bbe3c8faee9538157c212bd812a0) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - The scaffolded starter's header now matches the Nimbus site. The mobile menu (hamburger) button moved from the left of the header to the right, alongside the theme toggle. The search trigger stays reachable on mobile: it previously used `hidden sm:flex` and disappeared entirely below the `sm` breakpoint, leaving phones with no way to search — it now renders as a compact magnifying-glass icon button on small screens and expands to the full "Search ⌘K" control from `sm` up (the ⌘K hint is hidden on mobile).

- [#55](https://github.com/cloudflare/nimbus/pull/55) [`6881e4e`](https://github.com/cloudflare/nimbus/commit/6881e4e7fcec5ac7fd354d1ff31ef6345d9948aa) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Markdown tables in the scaffolded starter now round their outer corner cells to match the table's `0.75rem` border-radius. Because the table uses `border-collapse: separate`, the corner cell backgrounds — most visibly the muted `<thead>` fill — previously kept square corners that poked past the rounded table border. The first/last `<th>` in the header and the first/last `<td>` in the last body row now carry the matching `border-top-left`/`border-top-right`/`border-bottom-left`/`border-bottom-right` radius, so the fill clips cleanly to the border. Scoped to `:not([class])` authored markdown tables, so component-owned tables are untouched.

## 0.6.2

### Patch Changes

- [#42](https://github.com/cloudflare/nimbus/pull/42) [`8e4e210`](https://github.com/cloudflare/nimbus/commit/8e4e21081a77fff3779fad559b9e82149fa97a66) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Scaffolded projects now include a committed `nimbus.json` — a CLI-managed record of the `create-nimbus-docs` version, the `templates-v*` tag, the install root, and (as you `nimbus-docs add`) each installed component's provenance. Starter components also get an API-consistency pass: `type`→`variant` on Banner/Callout, `VersionPicker`→`VersionSwitcher`, hydration moved out of inline scripts into `.client.ts` files via the `mount()` primitive, and a single `getRouteFlags` layout-flag helper. The scaffolded `AGENT.md` now documents the `outdated` / `diff` / `add --overwrite` upgrade flow.

- [#34](https://github.com/cloudflare/nimbus/pull/34) [`b8a1235`](https://github.com/cloudflare/nimbus/commit/b8a12359835666b9ec698fd76cda05d6915bc11b) Thanks [@mvvmm](https://github.com/mvvmm)! - Bump for the `@cloudflare/nimbus-docs` minor in this release (full glob support for `ignore` in `internal-link`/`image-ref`) — no starter-source changes.

## 0.6.1

### Patch Changes

- [#32](https://github.com/cloudflare/nimbus/pull/32) [`a6491c8`](https://github.com/cloudflare/nimbus/commit/a6491c82ac78be346baaf9e4fd949a740b2bd5ac) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Fix a batch of UI stress-sweep defects in the starter components:

  - **TOC scroll-spy** no longer desyncs when a heading slugs to an empty id (e.g. an emoji-only `## 🎉`). The active-heading index now stays aligned with the full link/rail set instead of a resolvable-only subset, so every section below an unresolvable heading highlights correctly.
  - **Mobile sidebar** hamburger survives client-side navigation — the toggle re-binds on `astro:page-load` and tears down on `astro:before-swap` (via `mount()`), fixing a dead button after the first view transition, with the scroll lock balanced on a mid-open swap.
  - **Dialog** content taller than the cap now scrolls inside the panel (`overflow-y-auto`) so the close button stays reachable.
  - **Banner** long unbroken strings (including the framework deprecation banner's version URL) wrap instead of overflowing.
  - **PackageManagers** blocks with identical props on one page now get unique, incremental-build-stable DOM ids (per-page counter), fixing duplicate `id`/`aria-controls`.
  - Dev-only warnings: `<Steps>` around a bullet list, and duplicate labels within a `<Tabs syncKey>` group.

## 0.6.0

### Minor Changes

- [#27](https://github.com/cloudflare/nimbus/pull/27) [`1ebfb6c`](https://github.com/cloudflare/nimbus/commit/1ebfb6ccb275aee75d2c39b55407dcf731e4e142) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Align the sidebar, add a mobile "On this page" TOC, and tighten the docs layout's mobile and horizontal-overflow handling.

  - **Sidebar + TOC:** the sidebar filter gains a `press / to focus` kbd hint and a `placeholder` prop; sidebar groups render an optional leading icon (from `sidebar.group.icon`); and a sticky native-`<select>` "On this page" TOC now appears under the page title on viewports below `xl`, where the desktop TOC rail hides.
  - **Mobile sidebar drawer:** the drawer no longer dims or blurs the page — it slides in over a transparent overlay so the page copy stays readable, with a hairline edge instead of a shadow. Both the drawer panel and the desktop sidebar now paint their own background and contain overscroll, fixing a "no background" flash on fast/momentum scroll.
  - **Tabs:** a tab strip wider than its column now scrolls horizontally (scrollbar hidden) instead of leaking past the page width, and the active tab is scrolled into view on activate/restore.
  - **Prose:** long unbroken tokens (URLs, hashes) wrap within the content column via `overflow-wrap: break-word` instead of overflowing the page; code blocks and wide tables keep their own scroll handling.

## 0.5.2

### Patch Changes

- [#24](https://github.com/cloudflare/nimbus/pull/24) [`52d5a0c`](https://github.com/cloudflare/nimbus/commit/52d5a0c7308fbc6e9c45a1fb64e0efa1ea469a31) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Fix scaffolded starter behavior across client-side navigations and add a 404 page.

  - Re-run component initializers on `astro:page-load` so interactive components (code groups, dialogs, popovers, file trees, search) keep working after ClientRouter/view-transition navigations.
  - Scope the search dialog's global key handler to a module variable instead of an `<html>` attribute, preventing a duplicate `Cmd+K` handler from stacking on each navigation.
  - Mark inline SVG icons with `is:inline` so they render reliably.
  - Ship a default `404.astro` page in the starter.

## 0.5.1

### Patch Changes

- [#22](https://github.com/cloudflare/nimbus/pull/22) [`7ec9715`](https://github.com/cloudflare/nimbus/commit/7ec9715802bda52f235f6c78ce06383a6ede365a) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Republish with npm provenance attestations. Supersedes 0.6.0 / 0.5.0, which published without provenance and before the repo was public.

## 0.5.0

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

## 0.4.1

### Patch Changes

- [#16](https://github.com/cloudflare/nimbus/pull/16) [`479349b`](https://github.com/cloudflare/nimbus/commit/479349bffd5ee2f13d413322677bcb4982e4eb85) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Templates now pin nimbus-docs 0.5.0

  Scaffolds pin `nimbus-docs` at the minor they were generated against, so this
  CLI re-releases to ship templates on 0.5.0 — which drops the built-in
  incremental-build cache (the `incrementalBuilds` option, the `partialResolver`
  hook, and `nimbus-docs clean`). New scaffolds use a plain `astro build`; Astro
  7's native incremental building applies without any Nimbus opt-in.

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
