# `nimbus-docs lint` — engine architecture

The authoring-quality engine for MDX content.

## Architecture

```
src/lint/
  diagnostic.ts          Diagnostic envelope + RULE_CODES registry (+ diagnostic.schema.json)
  parse.ts               Sätteri mdxToMdast → mdast + unist positions; graceful parse-error
                         capture; findNodeAt helper (position → node) used by the style rules
  detectors.ts           detectors for the 8 Markdown style rules, run on the parsed tree
  rule.ts                Rule contract (code + run(ctx))
  config.ts              severity resolution + validateLintOptions (build/lint split,
                         IMPLEMENTED_CODES gate)
  disables.ts            nimbusDisableRules frontmatter + inline next-line comments
  engine.ts              lintFile / lintPaths / fixPaths — runs rules, applies disables, sorts
  fix.ts                 applyFixes — diagnostic-atomic, overlap-safe; returns the Set of
                         applied diagnostics so the caller doesn't hide advisory-only fixes
  format.ts              pretty + JSON formatters
  discover.ts            content .mdx file walk
  site-model.ts          entry enumeration + findDuplicateRoutes (group by mounted URL);
                         RouteTruth type read by internal-link
  rules/                 one file per rule (13 authoring + 2 build today)

src/_internal/
  astro-slug.ts          canonicalSlug + canonicalEntryUrl — mirror of Astro's content-layer
                         slug normalization (github-slugger + trailing-/index strip).
  collection-mount.ts    PRIMARY_COLLECTION + collectionMountPrefix — single source of truth
                         for "where does collection X mount?", from the versions and the
                         route map (`collection-routes.ts` reads route files). Shared by
                         index.ts and site-model.ts so duplicate-slug can't drift.
```

Parsing uses Sätteri's own `mdxToMdast` — the same parser that renders the
site — so the linter never disagrees with what ships. Positions are the
unist Points the parser emits (character offsets), so fix edits and the
pretty caret never drift on multibyte content.

## Build vs buy

The 8 commodity rules (heading hygiene, list/emphasis style, code-block
flags, bare URLs) once ran remark-lint's rules through a unified adapter.
They now use `detectors.ts`, which walks the tree the engine already
parsed and reports what those remark-lint 4.x rules reported, with no
second pipeline or bundled remark-lint stack.
`test/lint/native-parity.test.ts` holds them to a snapshot captured from
the remark-lint-backed rules, under each Markdown feature setting.

The rules that need Nimbus-specific knowledge (frontmatter directives,
sidebar truth, components registry, deploy URL, prompt-prefix
conventions) are hand-rolled.

## Tiers

- **Build validators** (`kind: "build"` in `RULE_CODES`) run in the
  integration at `astro:config:setup` and throw to fail the build. They
  can't be configured. Shipped: `duplicate-slug`, `mdx-syntax`.
- **Authoring rules** (`kind: "authoring"`) run in `nimbus-docs lint`,
  are off by default, and are enabled via the integration's `rules`
  option, which `astro build` and `astro dev` materialize to
  `.nimbus/lint.json`. Without that file every rule would be off, so
  `nimbus-docs lint` exits 1 asking for a build, unless `--rule` names the
  rule to run. The build is never gated on them.

## Shipped rules

| Rule | Tier | Detector | Auto-fix |
|---|---|---|---|
| `frontmatter-shape` | authoring | YAML parser | — |
| `description-required` | authoring | hand-rolled | — |
| `single-h1` | authoring | style detector | — |
| `heading-hierarchy` | authoring | style detector | — |
| `code-block-lang` | authoring | style detector | — |
| `code-block-prompt-prefix` | authoring | hand-rolled | — |
| `no-self-host-url` | authoring | hand-rolled | — |
| `heading-punctuation` | authoring | style detector | ✓ |
| `duplicate-heading-text` | authoring | style detector | — |
| `list-marker-style` | authoring | style detector | ✓ |
| `emphasis-style` | authoring | style detector | ✓ |
| `bare-url` | authoring | style detector | — |
| `internal-link` | authoring | hand-rolled | did-you-mean hint |
| `redirected-link` | authoring | hand-rolled | destination hint |
| `image-ref` | authoring | hand-rolled | ✓ (the site base) |
| `duplicate-slug` | build | hand-rolled | — |
| `mdx-syntax` | build | parser | — |

The style rules keep the Nimbus message text and surgical-fix shape; they
recover dynamic info (heading levels, marker chars) via `findNodeAt` at
the reported position.

## Decision record

### Parser: Sätteri `mdxToMdast`, not a decoupled remark parse

Sätteri exports `mdxToMdast` + unist positions for read-only inspection, so
the linter shares the renderer's parser: no shadow AST, no reintroduced
unified pipeline, Rust-fast. The remark-plugin no-op only affects
render-time transforms, not direct parse calls.

### Positions: unist character offsets, canonical

Taken straight from the AST. No bespoke position math and no byte/UTF-16
drift.

### `duplicate-slug` runs pre-build, groups by mounted URL

Three design calls hold this rule together:

- **Pre-build, in `astro:config:setup`.** Astro's content layer silently
  dedupes colliding routes, so post-build inspection cannot recover every
  owner. The check runs before one entry shadows another.

- **Two URL sources, one bucket.** Collisions span two surfaces:
  *content entries* under `src/content/<base>/` and *static page files*
  under `src/pages/`. Both produce real served URLs; either side can
  shadow the other. The check enumerates both, computes a canonical URL
  per source, groups by URL.

  - **Content entries** use `collectionMountPrefix(entry.collection,
    context) + canonicalEntryUrl(prefix, entry.id)` — the same logic
    the framework uses in `getIndexedTopLevel`, sidebar hrefs, etc.
    (shared from `_internal/collection-mount.ts` + `_internal/astro-slug.ts`).
    This catches cross-collection (`docs/blog/post.mdx` vs
    `blog/post.mdx`), version (`docs/v1/intro.mdx` vs
    `docs-v1/intro.mdx`), case-only, and folder-index-vs-leaf collisions.
  - **Static page files** use `enumerateStaticPageRoutes` —
    `pages/foo/bar.astro` → `/foo/bar`, lowercased + folder-index
    stripped to match Astro's `joinSegments`. Dynamic-segment files
    (`pages/[id].astro`) are skipped because their URLs come from
    `getStaticPaths` at build time and we can't enumerate them
    pre-build. This catches `pages/search.astro` shadowing
    `content/docs/search.mdx` at `/search`.

- **Scoped to page collections, honors custom bases.** Runs after
  content sync, over the page collections the Nimbus helpers loaded
  (partials and plain data collections aren't pages and don't
  participate). The walk uses `parseCollectionBases` to read each
  collection's `base:` override from `content.config.ts`: a
  `docsCollection({ base: "documentation" })` collection gets scanned at
  `src/content/documentation/` and tagged with key `docs`, rather than
  silently skipped because its on-disk folder doesn't match its
  registered key.

The rule lives in the integration rather than the standalone CLI because
its inputs (filesystem layout + `versions` config + `content.config.ts`)
are framework-side. The CLI doesn't need to re-do it.

**Known limitations:**

- Only `.mdx` entries are read, so `.md` pages, with or without a
  `slug`, aren't checked for collisions. A frontmatter `slug` replaces
  the path, as in Astro's glob loader; reading it costs one bounded read
  of each entry's frontmatter pre-build.
- A hand-rolled collection whose custom `generateId` ignores `slug` can
  get a false collision from an entry's `slug`, which fails the build.
  Remove the `slug` or make `generateId` honor it.
- Dynamic page routes (`pages/blog/[id].astro`) are skipped — their
  emitted URLs come from `getStaticPaths`. A collision between a
  dynamic page route and a content entry can still happen (Astro's
  routing-priority rules decide which wins) but the check won't see it.
- Custom `base:` extractor handles `docsCollection({ base: "x" })` and
  the other Nimbus helpers. Hand-rolled `defineCollection({ loader:
  glob({ base: "./src/content/x" }) })` collections fall back to using
  the collection key as the folder; users with non-conforming layouts
  see no detection for those collections.

### Slug mirror — `_internal/astro-slug.ts`

The framework URL builders (sidebar hrefs in `_internal/sidebar.ts`,
indexed-entry URLs in `getIndexedTopLevel`, version-alternate URLs in
`_internal/version-alternates.ts`) all derive URLs from `entry.id`. To
match what Astro actually serves, each runs through `canonicalEntryUrl`
in `_internal/astro-slug.ts`, which mirrors Astro's content-layer
normalization (`github-slugger` per segment + trailing-`/index` strip).

Custom `generateId` loaders aren't honored by this mirror. The duplicate
check reads a frontmatter `slug` itself (`enumerateEntries*`); other
callers holding a final `entry.id` use `entryRouteKey`.

`github-slugger` is bundled into `dist/` via tsdown's `noExternal`, so
this doesn't add a transitive dep for consumers.

### `internal-link` — route truth

At the end of `astro:build:done`, after Nimbus has written its own outputs,
the integration writes `.nimbus/routes.json` from what the build emitted:

- Astro's `pages` array;
- every file in the output directory Astro passes to the hook (the client
  directory for server output), as route keys: `foo/index.html` and
  `foo.html` become `/foo`, every other file keeps its extension
  (`/llms.txt`, `/welcome/index.md`, `/files/doc.pdf`). Left out: Astro's
  final `build.assets` directory (read at `astro:config:done`), `pagefind/`, `_nimbus/`, and the platform files
  `_headers`, `_redirects`, `_routes.json`, `.assetsignore`, and
  `_worker.js` at the output root;
- the site's redirects (see **Redirects** below);
- request-rendered pages from the request-route inventory, and concrete
  on-demand routes.

Links and routes share one key function (`_internal/route-key.ts`), so the
two sides can't drift. There is no reconstruction step, no slug mirroring,
and no coupling to Astro's internal URL-normalization rules. The
build/lint contract:

> After `astro build`, `.nimbus/routes.json` lists every URL the build
> produced. `nimbus/internal-link` resolves links against that set.

**What this catches that filesystem-based reconstruction misses:**

- Case normalization — Astro's content layer slugifies `entry.id` via
  `github-slugger` (lowercase, hyphenation, unicode), so `WIP/Foo.mdx`
  serves at `/wip/foo`. A reconstructed URL from the raw filesystem path
  would say `/WIP/Foo` and false-flag every valid lowercase link.
- `trailingSlash`, `i18n` routing, `build.format` — Astro applies these
  during route resolution. The emitted pathnames are the truth; any
  reconstruction has to chase Astro's config surface in lockstep.
- `draft: true` filtering — draft entries are excluded from the build,
  so a link from a published page to a draft page is genuinely broken in
  production. The materialized truth correctly excludes drafts.

**Why not reconstruct from filesystem?** Filesystem reconstruction must
duplicate Astro's routing and content-layer normalization. Using what the
build emitted avoids that coupling.

**`base` is never stripped.** Output paths are base-free, and the renderer
prefixes `base` to every authored root-relative link
(`_internal/authored-links.ts`). So an authored `/x` is compared with the
route `/x`, and a link that repeats the base (`/docs/x` under
`base: "/docs"`) is reported, because it renders as `/docs/docs/x`. The
hint prints the route as stored (`/x`). `ignore` patterns match the same
key, so they're written without the base too.

**Trade-off: lint requires `astro build`.** `astro sync` and `astro dev`
don't emit pages, so they don't update `.nimbus/routes.json`. CI is
build-then-lint, in one job or with the whole `.nimbus/` directory passed
as an artifact (lint exits 1 without `lint.json`). Files written by integrations
whose `build:done` runs after Nimbus's aren't captured.

**Missing route truth fails closed.** `astro build` invalidates the
previous file at the start of `astro:config:setup`, before any setup work
that can throw and before content sync: it deletes the file, or, when
that fails, overwrites it with `{ "incomplete": true }`. When it can do
neither, the build fails and asks for the permissions to be fixed. The old
file is still on disk then, and a separately run lint would accept it; the
build failure is what keeps a build-then-lint CI gate from passing. When an enabled link rule meets a `routes.json` that's
missing, unreadable, incomplete, or has an unknown `version`,
`nimbus-docs lint` reports one `error` on `.nimbus/routes.json` at 1:1,
whatever the configured severity, and doesn't run the rule
(`guardRouteTruth` in `engine.ts`). `nimbus-docs check` is a build-free
preflight: it checks links against a `routes.json` an earlier build left,
but a missing file is a note and disables the rule there. Reliable CI link
gating is `astro build`, then `lint`.

**Stale route truth → may miss new content.** Between builds, content
added since the last build doesn't appear in `routes.json`. Links to
those pages get flagged. This is correct behavior given the contract —
the site doesn't serve them yet either — but worth knowing when shipping
new content in a single commit alongside the links into it.

**Redirects (`link-resolver.ts`).** Route truth also lists the site's
redirect rules (the output's `_redirects`, then the `redirectsFile`
integration option) and, separately, Astro's redirect pages. A link that matches a source follows the chain,
whatever each hop's status, and is broken only when it ends nowhere, loops,
or passes 20 hops. A source wins over a file at the same path. Exact `200`
sources are rewrites; pattern `200` sources are dropped. `redirected-link`
reports links whose first hop is permanent, naming the last permanent
destination, written without `base`, resolving with `internal-link`'s
options (`RuleContext.optionsOf`). Sources match the pathname as written,
encoded, per `RouteTruth.redirectRules` (`netlify` with a `netlify.toml`,
else `cloudflare`): Cloudflare matches exactly, trailing slash included,
and applies a rule over an existing file; Netlify ignores the trailing
slash and applies only forced (`!`) rules over an existing file. Astro's
meta-refresh pages are recorded separately (`redirectPages`): when no rule
applies at a path (including a shadowed Netlify rule), the page sends the
link on to its destination. The incoming query passes through a destination without its own.
`ignore` applies to every destination in a chain. Route keys are only for built pages and globs. A line without a status is `301`
on Netlify, `302` on Cloudflare.

A near-match within Levenshtein distance 3 produces a "did you mean"
hint via the same `_internal/levenshtein.ts:suggest` helper the
PascalCase validator uses.

**`ignore` — full glob syntax via `picomatch`.** Both `internal-link` and
`image-ref` share `_internal/ignore-glob.ts` for matching their `ignore:
string[]` option — `**`, `*`, `{a,b}`, extglobs, and exact paths. This
supports leading any-depth wildcards as well as path-prefix patterns.
Compiled matchers are cached per `ignore` array identity, so a run
compiles each rule's list once per lint run, not once per file — callers
must pass the option through unfiltered for that cache to do anything
(see the helper's own doc comment).

**Unsupported coverage:**

- Hash-fragment validation is outside `internal-link`; it validates page
  existence only.
- Component URL props such as `<LinkCard href>` and `<Card link>` are not
  inspected; plain Markdown links, references, and `<a href>` are supported.
- Dynamic page routes cannot participate in pre-build duplicate detection.
- Per-collection rule overrides are not supported.
