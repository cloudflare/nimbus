# `nimbus-docs lint` — engine architecture

The authoring-quality engine for MDX content.

## Architecture

```
src/lint/
  diagnostic.ts          Diagnostic envelope + RULE_CODES registry (+ diagnostic.schema.json)
  parse.ts               Sätteri mdxToMdast → mdast + unist positions; graceful parse-error
                         capture; findNodeAt helper (position → node) used by adapter rules
  zod-adapter.ts         ZodError → RuleReport[] (for frontmatter-shape)
  remark-lint-adapter.ts unified Plugin → RuleReport[] — runs remark-lint rules against
                         Sätteri's mdast tree; the buy-side counterpart to zod-adapter
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
                         for "where does collection X mount?". Shared by index.ts and
                         site-model.ts so duplicate-slug can't drift from real routing.
```

Parsing uses Sätteri's own `mdxToMdast` — the same parser that renders the
site — so the linter never disagrees with what ships. Positions are the
unist Points the parser emits (character offsets), so fix edits and the
pretty caret never drift on multibyte content.

## Build vs buy

The 8 commodity rules (heading hygiene, list/emphasis style, code-block
flags, bare URLs) delegate detection to remark-lint via the adapter.
The 6 irreducible-core rules (anything that needs Nimbus-specific
knowledge: frontmatter schemas, sidebar truth, components registry,
deploy URL, prompt-prefix conventions) stay hand-rolled. Tests under
`test/lint/remark-spike-*.test.ts` verify the adapter boundary.

The remark-lint stack (`unified`, `vfile`, every `remark-lint-*`
package) is inlined into `dist` via tsdown's `noExternal`. Consuming
projects get zero new transitive deps when they install `nimbus-docs`.

## Tiers

- **Build validators** (`kind: "build"` in `RULE_CODES`) run in the
  integration at `astro:config:setup` and throw to fail the build. They
  can't be configured. Shipped: `duplicate-slug`, `mdx-syntax`.
- **Authoring rules** (`kind: "authoring"`) run in `nimbus-docs lint`,
  default to `error`, and are configurable via the integration's `rules`
  option (materialized to `.nimbus/lint.json`). The build is never gated
  on them.

## Shipped rules

| Rule | Tier | Detector | Auto-fix |
|---|---|---|---|
| `frontmatter-shape` | authoring | hand-rolled (zod-adapter) | — |
| `description-required` | authoring | hand-rolled | — |
| `single-h1` | authoring | remark-lint | — |
| `heading-hierarchy` | authoring | remark-lint | — |
| `code-block-lang` | authoring | remark-lint | — |
| `code-block-prompt-prefix` | authoring | hand-rolled | — |
| `no-self-host-url` | authoring | hand-rolled | — |
| `heading-punctuation` | authoring | remark-lint | ✓ |
| `duplicate-heading-text` | authoring | remark-lint | — |
| `list-marker-style` | authoring | remark-lint | ✓ |
| `emphasis-style` | authoring | remark-lint | ✓ |
| `bare-url` | authoring | remark-lint | — |
| `internal-link` | authoring | hand-rolled | did-you-mean hint |
| `image-ref` | authoring | hand-rolled | did-you-mean hint |
| `duplicate-slug` | build | hand-rolled | — |
| `mdx-syntax` | build | parser | — |

remark-lint-backed rules keep the Nimbus message text and surgical-fix
shape; the adapter recovers dynamic info (heading levels, marker chars)
via `findNodeAt` at the reported position.

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
    versions) + canonicalEntryUrl(prefix, entry.id)` — the same logic
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

- **Scoped to indexable collections, honors custom bases.** Only
  collections that survive `filterIndexableCollections` (`partials`,
  `_*`-prefixed names excluded) participate — non-routed collections
  aren't pages. The walk uses `parseCollectionBases` to read each
  collection's `base:` override from `content.config.ts`: a
  `docsCollection({ base: "documentation" })` collection gets scanned at
  `src/content/documentation/` and tagged with key `docs`, rather than
  silently skipped because its on-disk folder doesn't match its
  registered key.

The rule lives in the integration rather than the standalone CLI because
its inputs (filesystem layout + `versions` config + `content.config.ts`)
are framework-side. The CLI doesn't need to re-do it.

**Known limitations** (false negatives only — never false positives):

- `data.slug` frontmatter overrides aren't honored. An entry with a
  custom `data.slug` could collide with another URL and the check would
  miss it. Reading frontmatter from every entry pre-build adds noticeable
  I/O; deferred.
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

`data.slug` frontmatter overrides and custom `generateId` loaders aren't
honored by this mirror, so projects using either must supply route-aware
values at the public helper boundary.

`github-slugger` is bundled into `dist/` via tsdown's `noExternal`, so
this doesn't add a transitive dep for consumers.

### `internal-link` — route truth

The integration hooks into `astro:build:done` and writes Astro's emitted
`pages` array verbatim into `.nimbus/routes.json`. Every URL on that list
is a page Astro just wrote to disk — there is no reconstruction step, no
slug mirroring, and no coupling to Astro's internal URL-normalization
rules. The build/lint contract is straightforward:

> After `astro build`, `.nimbus/routes.json` reflects exactly what the
> site serves. `nimbus/internal-link` resolves links against that set.

**What this catches that filesystem-based reconstruction misses:**

- Case normalization — Astro's content layer slugifies `entry.id` via
  `github-slugger` (lowercase, hyphenation, unicode), so `WIP/Foo.mdx`
  serves at `/wip/foo`. A reconstructed URL from the raw filesystem path
  would say `/WIP/Foo` and false-flag every valid lowercase link.
- `trailingSlash`, `base`, `i18n` routing, `build.format` — Astro applies
  these during route resolution. The emitted pathnames are the truth;
  any reconstruction has to chase Astro's config surface in lockstep.
- `draft: true` filtering — draft entries are excluded from the build,
  so a link from a published page to a draft page is genuinely broken in
  production. The materialized truth correctly excludes drafts.

**Why not reconstruct from filesystem?** Filesystem reconstruction must
duplicate Astro's routing and content-layer normalization. Using the
emitted `pages` list avoids that coupling.

**Trade-off: lint requires `astro build`.** `astro sync` and `astro dev`
don't emit pages, so they don't update `.nimbus/routes.json`. CI is
typically build-then-lint. Local hooks running `nimbus-docs lint` should
chain `astro build` first. The rule's behavior when `routes.json` is absent
or stale is documented below.

**Missing route truth → silent skip.** When `.nimbus/routes.json` is
absent, `nimbus/internal-link` writes one warning line to stderr and
skips. Without route truth, every link would otherwise false-positive —
the worst possible outcome for a trust-sensitive rule.

**Stale route truth → may miss new content.** Between builds, content
added since the last build doesn't appear in `routes.json`. Links to
those pages get flagged. This is correct behavior given the contract —
the site doesn't serve them yet either — but worth knowing when shipping
new content in a single commit alongside the links into it.

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
