# Nimbus — agent context

> Read this first if you're an AI agent picking up work on the Nimbus codebase. Sister file [`CLAUDE.md`](./CLAUDE.md) mirrors this content — keep them in sync.

## What this project is

Nimbus builds documentation sites on Astro. The architecture splits into three tiers:

- **User-owned starter files** — visible UI components, layouts, and styling. Copied into the user's repo by `create-nimbus-docs` and edited freely from then on.
- **`nimbus-docs` npm package** — invisible plumbing (data helpers, validation, integration wiring, behavior primitives). Imported, not forked.
- **Registry** — optional components, utilities, and agent-handoff features installed on demand via `nimbus-docs add <slug>`.

Cloudflare is a first-class deploy target (the scaffolder defaults to it and ships `wrangler.jsonc`), but the framework is deploy-target agnostic — static output runs anywhere.

## Repo layout

```
monorepo/
├── packages/
│   ├── nimbus-docs/                       framework — integration, helpers, schemas, types, `nimbus` CLI
│   ├── nimbus-starter-source/             canonical source — fat tree; doubles as kitchen-sink dev app
│   │   ├── src/                           components, layouts, pages, demo content
│   │   ├── templates/                     per-variant content overrides (empty/, …)
│   │   └── starter.manifest.mjs           declarative generation policy (registry-only slugs, dev-only paths, variants)
│   └── create-nimbus-docs/                scaffolder (`pnpm create @cloudflare/nimbus-docs`) — CLI only, no templates
│       └── scripts/copy-template.mjs      generator: canonical source + manifest → variant dirs (--out)
├── apps/
│   └── www/                               docs site + registry hosting
│       └── registry/                      manifests.ts (source), components/, features/, registry.json
├── examples/
│   └── local/                             local sandbox (not drift-mirrored)
├── scripts/
│   ├── release.mjs                        release orchestration (detect → generate → verify → sync+tag → publish)
│   ├── sync-templates-repo.mjs            sync generator output to the orphan templates branch + tag templates-v<version> (idempotent)
│   ├── templates-check.mjs                PR CI: generate + scaffold + build
│   ├── check-no-major.mjs / freshness-guard.mjs  release guards
│   ├── local.mjs / local-add.mjs          local sandbox helpers
├── .generated/                            gitignored generator output (templates); scratch for local/CI/release
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## Build / dev / test

```sh
pnpm -r build                                    # build all packages and apps
pnpm --filter nimbus-docs build                  # framework only
pnpm --filter nimbus-docs typecheck              # tsc --noEmit
pnpm --filter nimbus-starter-source build        # build the canonical source (kitchen-sink)
pnpm --filter nimbus-starter-source dev          # run kitchen-sink dev server (every component visible)
pnpm dev                                         # alias for the above
pnpm build:templates                             # generate template variants into .generated/templates
pnpm templates:check                             # generate + scaffold + build one variant (CI runs on relevant PRs)
pnpm local                                       # spin up the local sandbox (generates + scaffolds offline)
```

Root `build` runs at default concurrency; `pnpm -r` topo order builds `nimbus-docs` first. `apps/www`'s `build` no longer builds `nimbus-docs`, so a bare `pnpm --filter @nimbus/www build` on a clean checkout fails — deploy via `pnpm run deploy` (its `predeploy` builds the framework) or root `pnpm build`.

## The boundary test (read before adding any file)

The architecture splits into three tiers, one test per tier:

| Tier | Lives in | Test |
|---|---|---|
| **Framework** | `packages/nimbus-docs/` | *"If I edit this, am I changing taste or fixing a bug?"* Bug = framework. |
| **Starter source** | `packages/nimbus-starter-source/` | *"Do edits change Tailwind classes or layout, or do they change call signatures?"* Tailwind/layout = starter source. |
| **Registry** | `apps/www/registry/` | *"Does every docs site need this on day 1?"* No = registry, install via `nimbus-docs add`. |

**When in doubt, default to framework; the starter should grow slowly.**

**The sharper cut — when a test above is ambiguous, or a single file mixes both:** *one correct answer → framework; a user might reasonably want a different answer → their repo.* A scroll-spy's active-heading math has exactly one right answer (framework); the rail's *look* does not (starter). When a `.client.ts` inlines both mechanism and taste, split it at that line — expose the mechanism as a `nimbus-docs/client` primitive and keep the taste in the user file — rather than filing the whole file under one tier. `tabs.client.ts` (thin glue over `initTabs`) is the target shape; a fat, all-mechanism `.client.ts` in the starter is the smell.

## Derived templates

**Drift discipline: canonical source → generator → orphan branch → tagged.** Hand-edits happen in one place, `packages/nimbus-starter-source/`. The generator (`packages/create-nimbus-docs/scripts/copy-template.mjs`) emits one directory per variant from that source plus the manifest. The CLI tarball carries **no templates**; distribution lives in this repo — the variants live on an orphan `templates` branch (no shared history with `main`), synced and **tagged `templates-v<create-nimbus-docs version>`** by the release job. At scaffold time `create-nimbus-docs` fetches its matching tag via giget (`github:cloudflare/nimbus/<variant>#templates-v<version>`); the tag's tree is templates-only, so the tarball stays small even though the repo also holds all of `main`. A starter edit therefore still produces a diff touching only `packages/nimbus-starter-source/**`; the `templates` branch is sync output, never hand-edited (a branch ruleset rejects human pushes, and `templates-v*` tags are immutable for everyone — including the bot).

The scaffolder never fetches a branch — every fetch is pinned to `#templates-v<own version>`, so `create-nimbus-docs@0.2.0` fetches templates tagged `templates-v0.2.0`, reproducibly. `--template-dir <path>` bypasses the network entirely (offline dev, and how `pnpm local` works).

The generation policy is declarative — `packages/nimbus-starter-source/starter.manifest.mjs` declares:

- `registryOnlyComponents` — UI slugs present in the fat tree but stripped from generated templates; users install on demand via `nimbus-docs add <slug>`.
- `devOnlyPaths` — path prefixes stripped from generated templates.
- `templates` — one entry per variant, with its content override. `template/` reuses the canonical `src/content/docs/`; `template-empty/` swaps in `templates/empty/content/docs/`. **Adding a variant is one manifest entry + one content dir** — the generator iterates this map.

Workflow when editing:

```sh
# 1. Make the edit in packages/nimbus-starter-source/
# 2. Generate the variants (into .generated/templates)
pnpm build:templates
# 3. Generate + scaffold + build one variant end to end (CI runs this on relevant PRs)
pnpm templates:check
# 4. Record a create-nimbus-docs changeset — a starter edit reaches users ONLY
#    through a CLI release that re-syncs + re-tags the templates branch. The
#    freshness guard fails the PR without it.
pnpm changeset
```

`examples/local/` is a sandbox — scaffolded by `pnpm local`, not part of template generation. `.generated/` is gitignored scratch.

## Key files to know

| File | What it does |
|---|---|
| `packages/nimbus-docs/src/integration.ts` | Astro integration entry — wires MDX, sitemap, Sätteri, MDX validator, Pagefind hook, virtual config module |
| `packages/nimbus-docs/src/index.ts` | Public API — data helpers (`getSidebar`, `getPrevNext`, `getTOC`, `getBreadcrumbs`, `getEditUrl`), page composition helpers (`getDocsStaticPaths`, `getDocsPageProps`), `defineConfig`, `renderEntryAsMarkdown` |
| `packages/nimbus-docs/src/types.ts` | Public types — `NimbusConfig`, `SidebarItem`, etc. Imports must come from `nimbus-docs/types` (never from main entry) |
| `packages/nimbus-docs/src/schemas.ts` | Content-collection schemas — `docsSchema`, `partialsSchema`, `defineDocSchema` |
| `packages/nimbus-docs/src/content.ts` | `docsCollection()`, `partialsCollection()` factories |
| `packages/nimbus-docs/src/_internal/validate.ts` | Zod config validation — content-author-friendly errors, offending-value echo, `editPattern` `{path}` enforcement |
| `packages/nimbus-docs/src/_internal/validate-mdx-content.ts` | Pre-build MDX PascalCase validator (content pass; see Sätteri note below) |
| `packages/nimbus-docs/src/_internal/parse-components-registry.ts` | Parses user's `src/components.ts` for the MDX globals registry |
| `packages/nimbus-docs/src/_internal/sidebar.ts` | Sidebar tree building, cross-collection refs, `sidebarHash` |
| `packages/nimbus-starter-source/src/components.ts` | User-side MDX globals registry — parsed by validator at build time |
| `packages/nimbus-starter-source/starter.manifest.mjs` | Declarative generation policy (registry-only slugs, dev-only paths, template variants) |
| `packages/create-nimbus-docs/scripts/copy-template.mjs` | Generator — canonical source + manifest → variant dirs (`--out`, or `generateTemplates()`) |
| `packages/create-nimbus-docs/src/scaffold.ts` | Scaffolder — giget fetch pinned to `#templates-v<version>`, plus the `--template-dir` offline path |
| `apps/www/registry/manifests.ts` | Registry source of truth — 33 component/utility/feature entries |
| `scripts/release.mjs` | Release orchestration — detect → generate → verify → sync+tag → publish (the changesets `publish` command) |
| `scripts/sync-templates-repo.mjs` | Idempotent sync of generator output to the orphan `templates` branch + `templates-v<version>` tag |
| `scripts/templates-check.mjs` | PR CI — generate + scaffold + build a variant |
| `scripts/check-no-major.mjs`, `scripts/freshness-guard.mjs` | Release guards (no unattended 1.0.0; CLI changeset required when templates change) |
| `scripts/local.mjs`, `scripts/local-add.mjs` | Local sandbox helpers |

## Sätteri trade-off (known constraint)

The integration sets `markdown.processor = satteri()` (Rust-based, fast) instead of unified. **Consequence:** remark plugins attached via `mdx({ remarkPlugins })` silently no-op. The MDX validator hit this and now runs as a pre-build content pass at `astro:config:setup` (see `validate-mdx-content.ts` for the pattern).

If you need framework-side validation/transformation, **use the content-pass pattern, not remark plugins**. User-facing remark plugins (Mermaid, diagrams, math, custom callouts) are not currently supported.

## Commit style

Short imperative phrases, sentence case. Examples from `git log`:

- *Ship MDX PascalCase validator and small polish improvements*
- *Add starter polish utilities*
- *Refresh registry output and sidebar collection docs*
- *Keep static markdown route in Cloudflare scaffolds*

No conventional-commit prefixes (no `feat:`/`fix:`). Each commit targets one cohesive change. Use a body paragraph to explain *why* when non-obvious.

When committing inside a session where other unrelated WIP exists (the user's working tree may have in-progress changes), use `git commit --only -- <paths>` to commit only the listed files without disturbing other staged work.

## Releasing

Releases are automated with [Changesets](https://github.com/changesets/changesets). `nimbus-docs` and `create-nimbus-docs` version independently; the private packages (`nimbus-starter-source`, `@nimbus/www`) are never versioned or published.

- **In your PR**, record user-facing changes with a changeset — this is the only human step, no hand-editing of `version` fields or `CHANGELOG.md`:

```sh
pnpm changeset        # pick the package(s) + bump, write a summary
```

  Commit the generated `.changeset/*.md` file alongside your change.

- **On merge to `main`**, `.github/workflows/release.yml` opens or updates a "chore: bump package versions" PR (branch `changeset-release/main`) that applies the pending changesets (bumps versions, writes each package's `CHANGELOG.md`).
- **Merging that PR** runs `scripts/release.mjs publish`, which: detects what's in the release, generates + verifies the templates against the exact `nimbus-docs` bits, **syncs + tags the orphan `templates` branch (`templates-v<version>`) before publishing**, publishes `nimbus-docs` before the CLI (so a live CLI never pins an unpublished dep), then dispatches the in-repo verify smoke — all unattended, with npm provenance.
- A half-failed release recovers via the `publish_only` `workflow_dispatch` input (sync is idempotent; an orphan tag is harmless).
- **Hard requirement: the monorepo must be public before the first release.** Unauthenticated giget scaffolds only work against a public repo, and this repo can't expose templates without exposing source. Until the flip, scaffolds need `GIGET_AUTH`. Run a full-history secret scan before going public. The `templates` branch and `templates-v*` tags are protected by repo rulesets (branch: bot-App-only updates; tag: App-only creation + empty-bypass update/delete, so published tags are immutable for everyone).

The root `CHANGELOG.md` is frozen; per-release notes live in `packages/*/CHANGELOG.md`.

## What to read first

If you're picking up a new piece of work:

1. This file + [`README.md`](./README.md) — architecture, the boundary rule, and the build/dev/test workflows
2. *Key files to know* (above) and the package source under `packages/nimbus-docs/src/`
3. Public feature docs under `apps/www/src/content/docs/`

## Operating principles for agents

- **Edits to UI / starter content happen in `packages/nimbus-starter-source/`, never on the `templates` branch.** The `templates` branch is sync output; direct edits are rejected by its branch ruleset and would be clobbered by the next release sync. A starter edit needs a `create-nimbus-docs` changeset to reach users (the freshness guard enforces this).
- **Run the build before claiming work is done.** `pnpm --filter nimbus-docs build` for framework changes, `pnpm --filter nimbus-starter-source build` for end-to-end verification of the canonical source, `pnpm templates:check` to confirm the generator + scaffolder + template build still work, and `pnpm -r test` for the registry tier-invariant guard.
- **Don't add `nimbus-docs add` recipes for things that belong in the framework.** The boundary test applies to feature placement, not just file placement.
- **Prefer asking about design intent over inferring it from code.** The framework's decisions are explicit and often non-obvious, and the rationale isn't always in the codebase.
