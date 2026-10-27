# Contributing to Nimbus

AI coding agents have changed how software gets made. The teams that do well
adapt their workflows to that change rather than bolting agents onto the old one.

This repo explores what building software with agentic workflows looks like. Treat it as a long-running experiment.

Writing code is no longer the bottleneck — agents handle most of the research,
implementation, and first-pass review. Deciding _what_ to build and _how_ is
where the leverage is, so that is where we plan to spend human attention and what we ask
contributors to help with.

## How to contribute

Two paths:

| You want to… | File it as… | Humans | Agents |
|---|---|---|---|
| Report a bug or propose a fix | an **Issue** | [New issue](https://github.com/cloudflare/nimbus/issues/new/choose) | [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE) |
| Request a feature or enhancement | a **Discussion** | [New discussion](https://github.com/cloudflare/nimbus/discussions) | [`.github/DISCUSSION_TEMPLATE/feature-request.yml`](.github/DISCUSSION_TEMPLATE/feature-request.yml) |

A well-framed problem is worth more to us than a finished PR. Send the
clearest account of the bug, or the strongest case for the feature — the full
context that lets us guide an agent through the work. If we take it on, we
implement it and try our best to attribute it to you.

## Pull requests

Start with an issue or a discussion, not a PR. If we decide to take your bug or
feature forward, a maintainer approves you right there in the thread — from then
on your pull requests stay open and go through normal review. Until then, PRs
from outside the team are closed automatically and pointed back here.

A drive-by AI-generated PR is cheap to write and expensive to review. Deciding
what to build, and how, is the part we'd rather do with you up front.

## For maintainers

Before you open a PR:

- Put the change in the right place: framework bugs and plumbing in `nimbus-docs`, styling and layout in the starter, optional extras in the registry.
- Edit `packages/nimbus-starter-source/`, never the `templates` branch — that's generated, and direct edits get clobbered on the next release.
- Add a changeset for anything user-facing. Starter edits need a `create-nimbus-docs` changeset, or the freshness guard fails the PR.
- For every intentional public API break, apply the `breaking-change` PR label and add a linked entry to the comprehensive upgrade manifest. Use `optional` only when every existing site keeps building with the same output without acting; conditional entries stay `review-required`. Every entry carries manual guidance; add a migration ID, detector, transform, bounded task, and focused fixtures only when maintainers deliberately classify the change as common, mechanical, and canonically detectable. Run `pnpm upgrades:check`. CI verifies the declaration, pending changeset, and manifest continuity. If a shipped release missed an entry, add it with that release's `introducedIn` and `"backfill": true`, as `review-required` with no migration ID, linked to a pending `@cloudflare/nimbus-docs` changeset; sites upgrading across that release then see it, and the check lists it for review.
- Check that `pnpm typecheck`, `pnpm -r test`, and `pnpm templates:check` pass.

For Markdown pipeline changes, extend the small mixed-format fixture in
`scripts/fixtures/content-integrity/`. The template check installs the packed
framework into a starter and verifies rendered content across clean and warm
builds. Use bounded combinations in unit tests to check preservation of unrelated
source across formats, nesting, Unicode, and line endings. A parser-only pass or
one production corpus is not sufficient evidence of consumer compatibility.

### Local development

Requires **Node 22.23.4+, 24.15.0+, or 26+** and **pnpm 10** (pinned via `packageManager`, so Corepack fetches it for you). Node 23 and 25 are not supported for contributing. Use the latest patched release of your Node line.

```sh
pnpm install
pnpm dev                 # kitchen-sink dev server at http://localhost:4321 — every component on one page
```

`pnpm dev` runs the server in the background and prints its own `astro dev stop` / `astro dev status` commands (Ctrl-C won't stop it). Edit files under `packages/nimbus-starter-source/src/` and the page hot-reloads.

Working on the CLI, templates, or a real scaffold:

```sh
pnpm build:templates     # regenerate the shipped template variants
pnpm templates:check     # generate + scaffold + build one variant end to end
pnpm local               # scaffold a throwaway site against your local packages
pnpm typecheck           # typecheck the whole workspace
pnpm -r test             # every package's tests, incl. the registry tier-invariant guard
RUN_PACKED_MIGRATION=true pnpm --filter @cloudflare/nimbus-docs test   # also the packed-migration test (installs from npm; CI runs it on main and the release PR)
```

Working on the docs site (`apps/www`):

```sh
pnpm --filter "@nimbus/www..." build   # build www plus the workspace packages it depends on
```

Production deploys only from the Release workflow; see [Releases](#releases).

A bare `pnpm --filter @nimbus/www build` doesn't rebuild `nimbus-docs`, so after a version bump it fails with a stale-version error until the package is rebuilt.

`CLAUDE.md` / `AGENT.md` carry the deeper architecture notes — you don't need them to run the repo.

### Releases

Merging the "chore: bump package versions" PR publishes to npm, then automatically deploys the docs site and its registry. A run that only opens the version-bump PR does not deploy www. Production is only deployed by the Release workflow.

If npm publishes but the www deploy fails, run the Release workflow manually from `main` (**Actions → Release → Run workflow**) while no other Release run is in progress; a manual run can cancel a queued one, so rerun any it cancels. It skips publishing, builds the newer of the two packages' npm `latest` release tags, and deploys only if both package versions at that commit match npm `latest`. Rerunning a whole push-triggered Release run does not redeploy if nothing new was published.

If publishing failed partway, recover any missing git tags as the release script instructs. If a package still needs publishing, rerun the push-triggered run; it deploys once publishing completes. If both packages are already on npm, use the manual run.

There is no rollback to an older release: the deploy refuses a release older than npm `latest`, so fix forward with a new release. In an emergency, Cloudflare's Worker deployment rollback is the only sanctioned production change outside the Release workflow.

`nimbus-docs add` installs components from the registry the docs site serves, so the two must ship together. Before the deploy, the registry still serves the previous release's components, which may lack what the new package needs. Don't deploy from `main` between merging a feature and publishing its release, either: the registry would then serve components that need APIs the published package doesn't have yet. `add` warns when the registry and the project's `@cloudflare/nimbus-docs` versions differ. The release deploy, fork PR Previews and PR Preview cleanup use the `cloudflare` GitHub Environment with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; publishing uses a separate `release` Environment with `APP_ID` and `APP_PRIVATE_KEY`. Both environments are restricted to `main`, with no repository-level copies of these secrets, so only code on `main` can use them; anyone who can merge to `main` can reach them. Only the release deploy should update production, but that is a policy, not a boundary: Workers Builds can also deploy with its own token (see below).

On npm, both `@cloudflare/nimbus-docs` and `@cloudflare/create-nimbus-docs` need a trusted publisher for `cloudflare/nimbus`, workflow `release.yml`, environment `release`, with direct `npm publish` allowed. Existing connections cannot be edited. Cut over each package separately, when that package next has a planned release:

1. Add its new environment-bound connection shortly before that release.
2. Publish that package within two days, and confirm **the new connection** shows as validated. A successful publish alone does not prove it was used while the old connection remains.
3. Only then delete that package's old connections without the `release` environment.

If a new connection expires before it validates, delete and recreate it near the next release; keep the old connection until its replacement validates. During this cutover, the old connections still allow OIDC publishing without the environment restriction. That restriction applies to trusted-publisher connections only after the old ones are removed; npm token and manual publishing access are configured separately in npm's Publishing access settings.

### Live www Previews

[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) deploys each pushed branch, except `main`, Dependabot branches, and `templates`, to a [Worker Preview](https://developers.cloudflare.com/workers/previews/) whose name is derived from the branch name (for example, `feat/foo` becomes `feat-foo`). The Cloudflare bot comments its URL on the PR, and its dashboard link ends in `/previews/<name>` with the exact name. Test the PR's registry with `NIMBUS_REGISTRY_URL=<url>/registry`. Fork branches are not built; see [Fork PR previews](#fork-pr-previews). Closing a PR deletes its branch's Preview; Previews for branches without a PR are evicted by Cloudflare's per-Worker Preview limit.

Pushes to `main` build but never update production; only the release deploy does. The `nimbus-docs` Worker's Builds settings must keep that true:

| Setting           | Value                                                                      |
| ----------------- | -------------------------------------------------------------------------- |
| Root directory    | `apps/www`                                                                 |
| Build variable    | `SKIP_DEPENDENCY_INSTALL=1`                                                |
| Build command     | See below                                                                  |
| Production branch | `main`                                                                     |
| Deploy command    | `echo "Production deploys run from release.yml"` (never `wrangler deploy`) |
| Preview builds    | Enabled                                                                    |
| Preview command   | Default, `npx wrangler preview`                                            |
| Preview URLs      | `<name>.nimbus-docs.com`; `workers.dev` off (`preview_urls`, next release) |
| Build watch paths | Default (include `*`, exclude nothing)                                     |

Build command:

```sh
case "$WORKERS_CI_BRANCH" in dependabot/*|templates|fork-*) exit 1 ;; esac && pnpm install --frozen-lockfile && pnpm run build:workers
```

The build command stops Dependabot, `templates` and `fork-*` builds before any of their code runs (`fork-*` names belong to fork PR Previews, so don't use them for branches), so those commits show a failed Workers Builds check. Keep the default watch paths: the `pr preview` label needs a Preview of the PR's latest commit, and a skipped build leaves an older one. Workers Builds runs other branches' code with its own Cloudflare API token, so anyone who can push a branch can use that token. If PR-close cleanup fails, a build still running at close recreates the Preview, or a PR doesn't target `main` or is retargeted away from it, run `pnpm exec wrangler preview delete --name <name> --skip-confirmation`, using the name from the bot's dashboard link, from `apps/www` with access to the Worker account.

### Preview releases

To let someone install and test a PR before it merges, add the `pr preview`
label to it. That triggers the [Preview release](.github/workflows/preview-release.yml)
workflow, which builds `@cloudflare/nimbus-docs` and `@cloudflare/create-nimbus-docs`
and publishes them to [pkg.pr.new](https://pkg.pr.new) — nothing hits the npm
registry. A bot then comments on the PR with install commands like:

```sh
pnpm add https://pkg.pr.new/@cloudflare/nimbus-docs@<PR#>
```

The label is removed automatically; re-add it to publish a fresh preview. The PR's www Preview must have deployed successfully for the same commit first. If it is still building, wait and reapply the label. An on-demand preview scaffold writes that Preview's `/registry` URL to its gitignored `.env`, which `nimbus-docs add` reads; `nimbus.json` records Preview provenance but does not configure `add`. Released scaffolds continue using the production registry. After a new push, reapply the label and reinstall the preview packages to match the new registry code. A cloned preview scaffold needs the env override set again.

Preview packages carry the version the release PR would give them, as a
pre-release such as `0.16.0-pr.<number>.sha<sha>`, so installing one on a site runs
the next release's upgrade entries. A package without a pending changeset gets a
patch bump. CI also tests every PR at the version its changesets produce. A branch
behind the latest release gets no preview; merge main into it first.

`create-nimbus-docs` previews scaffold from the PR's own starter, bundled into the
preview package and pinned to the matching `@cloudflare/nimbus-docs` preview. They
record no reviewed baseline in `nimbus.json`.

#### Fork PR previews

Fork branches get no Workers Builds Preview. Instead, the `pr preview` label on a fork PR starts the [Fork preview build](.github/workflows/fork-preview-build.yml), an ordinary fork run with no secrets. When it finishes, the [Fork preview](.github/workflows/fork-preview.yml) workflow, which always runs from `main`, deploys only the built files to `https://fork-<PR#>.nimbus-docs.com` and comments the URL and commit. Add the label, then approve the fork's pending runs; Preview release waits up to 15 minutes for that Preview before publishing packages against it.

- The deploy goes ahead only while the PR's head is the built commit and the label is still on it. The label comes off after each build, so review the commit in the comment, and reapply the label for a fresh preview.
- A fork Preview serves unreviewed contributor code on `nimbus-docs.com`. The deploy writes `_nimbus-preview-sha.txt` and a `noindex` `_headers` itself and uses `main`'s `_redirects`, so a fork's own headers and redirects are not previewed. It refuses a `_worker.js`.
- Fork workflow approval must stay at "Require approval for all external contributors". A fork's own copies of these workflows run once approved, so approval is what stops a fork building or publishing on every push.
- Closing the PR deletes `fork-<PR#>`. If that fails, run `pnpm exec wrangler preview delete --name fork-<PR#> --skip-confirmation` from `apps/www`.
