# @cloudflare/nimbus-docs

## 0.12.0

### Minor Changes

- [#93](https://github.com/cloudflare/nimbus/pull/93) [`43c161a`](https://github.com/cloudflare/nimbus/commit/43c161a993385c9fd121c2732b0fa37a6d74175d) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Add first-party OpenAPI reference support to Nimbus.

  - Configure local or inline OpenAPI specs as routed, version-aware collections with operations, schemas, tags, webhooks, generated samples, and every declared request-body media type.
  - Install an editable `api-layout` UI that shares Nimbus's docs shell, navigation, breadcrumbs, banners, mobile behavior, and deep-linkable field and code-sample controls. The copied `ApiFieldList` field iterator is explicitly typed so the scaffolded UI type-checks cleanly under a consumer's strict TypeScript.
  - Publish per-page Markdown, agent indexes, corpus entries, coordinate manifests, and `api.ref:` citations across local and cross-site documentation.
  - Harden generated-consumer delivery with exact registry dependencies, working pnpm installs from scaffold roots, and base-aware canonical, Markdown, sitemap, and agent URLs through the new public `withBase` helper.
  - Control how operation pages are addressed, and stay resilient to messy specs. By default, operations that lack a usable `operationId` no longer abort the build — they warn and fall back to a path-derived coordinate, so real-world specs (e.g. Cloudflare's `brand-protection` operations) build; set `api[].requireOperationId: true` on specs you own to keep that fatal, while route-hostile paths and coordinate collisions stay fatal regardless. For readable, path-derived URLs, opt into the `resource-action-v1` route convention: set `api[].routes: { convention: "resource-action-v1" }` (per version in a family) to derive slugs like `charges/list` from an operation's method and path, decoupled from `operationId` so route-hostile identifiers no longer poison URLs. Trim shared bases with `stripPathPrefixes` (e.g. `["/v1"]`), pin individual pages with an `operations` (`operationId` → slug) map, and inspect how each slug resolved (`override` / `derived` / `fallback`) via the new `getApiRouteProvenance` export. Derivation collisions, reserved-route segments, unused overrides, cross-version slug drift, and unknown config keys (e.g. a `stripPrefixes` typo for `stripPathPrefixes`) are reported with pointed messages; the default (no `routes`) keeps the legacy `operationId` slugs unchanged.

- [#104](https://github.com/cloudflare/nimbus/pull/104) [`79d6430`](https://github.com/cloudflare/nimbus/commit/79d6430fd96d0446a27f3c32375fe3f8ddce7c1a) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Add server-output support and the `@cloudflare/nimbus-docs/adapters` export.

  Nimbus can now target on-request (server) output in addition to static. A new `@cloudflare/nimbus-docs/adapters` public export ships the adapter recipes plus the shared `astro.config` and `wrangler.jsonc` emitters, and two new CLI verbs opt an existing site in: `nimbus-docs add server-output --adapter <vercel|node|netlify|cloudflare>` (alias `nimbus-docs add adapter-<id>`). The installer rewrites `astro.config` at the `// nimbus:adapter` marker and, for Cloudflare, creates a server `wrangler.jsonc` or replaces an exact Nimbus static config. Cloudflare installs add request rendering when the active Nimbus config has no explicit rendering policy; explicit or ambiguous policies are preserved and receive an agent-ready handoff. Adapter dependencies are saved at their exact resolved versions so subsequent runs accept the installed declaration. Custom and alternate Wrangler configs are preserved with manual adaptation instructions.

  Withdraw the `gated` config option because it did not hold as a confidentiality boundary. Existing `gated` config now fails with a migration error; to keep a page out of the build, move the page out of a routed content collection.

  Fix env preflight precedence and parsing to match Vite, including empty shell overrides, last-wins `.env*` files, and inline dotenv comments. Adapter dependency validation now resolves pnpm catalog declarations, and compatibility warnings reflect the versions installed by the command.

  Fix `NimbusHead` URLs for sub-path deployments by applying Astro's configured base to sitemap, LLM index, social image, JSON-LD, canonical, and version-alternate URLs. Root deployments and already-based paths are unchanged.

  Keep registry component render counters compatible with adapter-defined `Astro.locals` types, including Cloudflare server output.

- [#104](https://github.com/cloudflare/nimbus/pull/104) [`862df4a`](https://github.com/cloudflare/nimbus/commit/862df4ac2786fbc46e0e40a5517c27f4dc39e8da) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Add Cloudflare request rendering for canonical content collections.

  Nimbus now supports collection-level build and request rendering policies with validated defaults and per-collection overrides. Request-rendered prose and API routes use response-aware page helpers, prepared API models, request-safe partial headings, 404 responses, and build-derived syntax-highlighting assets without shipping source OpenAPI specs to Workers. Cloudflare server scaffolds enable request rendering by default, and generated pnpm configuration installs Satteri's WASI fallback alongside the current architecture.

  Preserve sitemap, Pagefind, Markdown, and agent-index discovery for request-rendered routes. Pin the tested sitemap integration, clean up synthetic Pagefind staging files transactionally, and generate cross-collection Open Graph images in new starters.

### Patch Changes

- [#99](https://github.com/cloudflare/nimbus/pull/99) [`2965d9f`](https://github.com/cloudflare/nimbus/commit/2965d9ff95bc06a90dee6eaf1e7cc7383fee36e1) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - - Honor `noindex: true` on machine discovery surfaces. `noindex` pages now drop out of `/llms.txt`, per-section `llms.txt`, and the `/llms-full.txt` corpus (matching on-site search, which already excluded them) while staying directly addressable and navigable. A single exported `isDiscoverable` predicate defines the contract for custom index/corpus routes.
  - Pin `@vercel/detect-agent` to `1.2.3`, the last release published with npm provenance. Versions `1.2.4`/`1.2.5` dropped provenance, tripping pnpm's `ERR_PNPM_TRUST_DOWNGRADE` and blocking lockfile updates. Pinning holds at the attested artifact until upstream restores provenance.
  - Fix navigation for pages under CJK (percent-encoded) paths. Route matching now decodes percent-encoded request paths (`toRouteKey`), so active sidebar state, breadcrumbs, and prev/next resolve correctly instead of falling back to a URL-encoded trail; the breadcrumb URL fallback also decodes segment labels.

## 0.11.0

### Minor Changes

- [#86](https://github.com/cloudflare/nimbus/pull/86) [`b4b0dc3`](https://github.com/cloudflare/nimbus/commit/b4b0dc3b8746bd148b82eca458fbc5a1f500acd7) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - `makeDisclosure` now marks closed content `inert` so collapsed regions leave the tab order, keeping keyboard focus out of hidden disclosure panels. Add a `manageInert` option (default `true`) to opt out for consumers that manage their own focus.

- [#90](https://github.com/cloudflare/nimbus/pull/90) [`74702e0`](https://github.com/cloudflare/nimbus/commit/74702e07d1e74f9fa2f10a2d89b030801845567c) Thanks [@mvvmm](https://github.com/mvvmm)! - `getDocsStaticPaths` and `getCollectionStaticPaths` now include a `cacheKey` (derived from the entry's `digest`) on each returned path. This enables Astro's experimental incremental build cache to skip re-rendering unchanged pages. No-op when `experimental.incrementalBuild` is not enabled in `astro.config.ts`.

### Patch Changes

- [#95](https://github.com/cloudflare/nimbus/pull/95) [`79a8448`](https://github.com/cloudflare/nimbus/commit/79a8448e991dff458a3658aa91137ce62b0cfc8b) Thanks [@mvvmm](https://github.com/mvvmm)! - Bump `nanoid` to 3.3.18 to resolve GHSA-2v37-7h3g-55p8 (CVE-2026-67213): custom generators can loop indefinitely when size is zero.

## 0.10.0

### Minor Changes

- [#71](https://github.com/cloudflare/nimbus/pull/71) [`e5d74f9`](https://github.com/cloudflare/nimbus/commit/e5d74f9d8452caa0c8ae6b02b61c8e83ff3c9f1f) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Enable MDX optimization by default to reduce large-site build memory usage. Sites can opt out with `mdx: { optimize: false }`.

  Verified the generated starter with optimization on and with `mdx: { optimize: false }` forced; the rendered HTML is structurally equivalent for element names, attributes, and non-whitespace text. Render parity is semantic and structural rather than byte-identical: raw bytes differ due to serializer escaping and inter-block whitespace, but the rendered document is lossless.

  Spot-checked the starter `components` page, which includes JSX tags in prose, inline code with `<...>`, quoted code, and package names. The optimized and opt-out renders preserve those special-character text probes and match structurally.

  Constrain the supported Astro peer range to `>=7.0.0 <7.1.0 || >=7.2.0 <8.0.0`: the 7.1.x line is excluded while its static-build regression is open upstream, but 7.2.x is admitted (verified against a sub-path build). Generated templates and the dev pin stay on the verified 7.0.x line.

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

### Patch Changes

- [#77](https://github.com/cloudflare/nimbus/pull/77) [`1c49268`](https://github.com/cloudflare/nimbus/commit/1c49268f0a0a5cb3bf1c2473dddfa43dd7837014) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Fix `NimbusHead` emitting base-less SEO URLs on sub-path deployments (e.g. `base: '/docs'`).

  `new URL(path, Astro.site)` resolves against the origin only and drops the configured `base`, so the `rel=sitemap` link, the LLM-index `rel=alternate`, `og:image`/`twitter:image`, the JSON-LD `isPartOf.url`, the versioned `canonical`, and the cross-version `rel=alternate` all pointed at the origin root and 404'd under a sub-path. Every internal path handed to `new URL(..., Astro.site)` is now `base`-prefixed via a `withBase` helper, matching the existing `BASE_URL` handling for the favicon and Shiki stylesheet.

  Root deployments (`base: '/'`) are unaffected: the helper is a no-op when no base is configured, and already-based paths pass through unchanged (idempotent).

- [#80](https://github.com/cloudflare/nimbus/pull/80) [`ec71a7b`](https://github.com/cloudflare/nimbus/commit/ec71a7b9d4cc3061d4d5d70478ba4b8e002aab6d) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Fix syntax-highlighted code rendering uncoloured in dev on sites with a non-root `base` (e.g. `base: "/docs"`). The dev middleware that serves `_nimbus/shiki.css` compared the request path exactly against the based asset path, but Vite strips `base` from `req.url` at a non-root base, so the request 404'd and tokens fell back to their inherited colour. It now matches by suffix, serving the stylesheet regardless of how Vite presents `base`. Production was unaffected — the stylesheet is written statically at build time.

## 0.9.0

### Minor Changes

- [#64](https://github.com/cloudflare/nimbus/pull/64) [`e1e4e8d`](https://github.com/cloudflare/nimbus/commit/e1e4e8d313952ffb197eb31f0a63983e93d20adc) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Add `nimbus-docs check` — a build-free preflight that reports readiness honestly

  One command a human, CI, or agent runs to catch setup, structural, authoring, and type problems before a build. It runs four categories — environment (Node floor, config locatable, `site` not a placeholder, pagefind, wrangler), structure (config Zod, duplicate routes, MDX component resolution — the same validators the build gates on), authoring (the shipped lint rules), and types (a build-free type-check) — and normalizes every result into one envelope.

  The types category type-checks your TypeScript with your project's own `tsc`, build-free — no `astro build`, no `astro sync`, nothing spawned (your TypeScript is resolved from your project, never bundled into the CLI). Astro transpiles rather than type-checks, so a type error never fails the build on its own; catching it in the preflight is the point. Because `tsc` can't parse `.astro` SFCs, their internals and prop types are out of scope (that needs `astro check`); an injected ambient `declare module "*.astro"` keeps `.ts` files that import `.astro` components from being false-flagged.

  **The report separates two axes that a naive error count fuses: buildability vs. correctness, and evaluated vs. not-evaluated.** `--json` carries three top-level signals:

  - **`status`** (`passed` | `failed` | `partial`) — the whole-run verdict across every scope that ran.
  - **`readiness`** (`buildable` | `blocked` | `unknown`) — derived from env + structure only: does the project clear Nimbus' buildability checks? A type error is `status: failed` but `readiness: buildable` (the site still builds — Astro strips types); a placeholder `site` is `blocked`.
  - **`ok`** — kept for back-compat, still exactly `errors === 0`.

  Exit is `1` only when `status === "failed"` (`ok === false`); `partial` and `readiness` never move it. Usage errors are `2`.

  Coverage is a first-class channel, not a fake warning. A sub-check that can't run yet — opt-in authoring rules or link-checking before `astro build` materializes `.nimbus/lint.json` / `.nimbus/routes.json`, or the type-check before `.astro/types.d.ts` exists — is reported as a **note** under `scopes[].notes[{ code, reason, requiresBuild?, requiresInput? }]`, counted in `summary.notes`. A note is never a `finding`, never carries a `fix`, and never affects the exit code; it resolves by making the missing thing exist (a build), not by `--fix`. A run that skipped types or authoring rules therefore never declares itself build-ready on an unverified scope. The headline is earned: _"Buildable"_ on a scaffold whose correctness scopes are still notes, _"Ready"_ only when every scope that ran evaluated clean with zero notes.

  - `--json` emits `{ ok, status, readiness, summary{errors,warnings,notes,fixable,durationMs}, scopes[{scope,status,reason?,notes[]}], findings[{scope,code,severity,file,line,message,fixable,fix}] }`. An agent's fix loop terminates on `status !== "failed" && summary.fixable === 0` — a `partial` run with nothing left to fix is a stop (optionally build, then re-check), not a `--fix` retry.
  - `--fix` applies safe fixes (installs, config rewrites via a static parse of `astro.config.ts`), prompting on a TTY for values it can't invent (e.g. the production `site` URL) and skipping them headless.
  - `--env` / `--structure` / `--lint` / `--types` run a single category.
  - `init` now ends with the env readiness pass — using the same scope-status vocabulary — so a fresh scaffold hears about a placeholder `site` at setup time.

  `lint` is preserved as a first-class command with its own "zero `.mdx` → exit 1" guard; `check --lint` runs the same rules inside the preflight envelope. (Unlike `lint`, a config-only project with no `.mdx` is not an error for `check`.)

  Config validation for `site` is now stricter: it must be an absolute `http(s)://` URL with a host. Previously a value missing the `//` (e.g. `https:example.com`) slipped through `new URL()` and shipped a broken canonical origin; it is now rejected both build-free by `check` and at build time by the config gate.

## 0.8.2

### Patch Changes

- [#59](https://github.com/cloudflare/nimbus/pull/59) [`01a5d23`](https://github.com/cloudflare/nimbus/commit/01a5d23c1e18340fc5a05ee2b0848c81d3eea9fd) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Fix overview-leaf reordering a flat top-level sidebar per page

  In `indexDisplay: "overview-leaf"` mode, the section-root pin relabelled and moved any top-level link whose slug matched the current section — including standalone top-level pages with no content beneath them. On a flat top-level of single pages, that pulled the current page to the front and renamed it "Overview" on every page. Pinning now requires the section to actually have content under it, so standalone pages stay put and keep their label.

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
  `<Render>` attributes map to a partial collection id.

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
