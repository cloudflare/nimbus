---
"@cloudflare/nimbus-docs": patch
---

Fix correctness and upgrade-path bugs.

**Generated Markdown**

- Per-page `.md` files and `llms-full.txt` keep the indentation of code blocks in MDX pages, so YAML and Python keep their meaning. Code inside `<Aside>` gets the `> ` prefix on every line.
- `<PackageManagers>` Markdown includes the package for every `type` and matches the HTML commands. `type="dlx" pkg="@cloudflare/nimbus-docs" args="list"` now renders `npx @cloudflare/nimbus-docs list` instead of `npx list`.

**Links, sitemap, and routes**

- Sidebar, navigation, breadcrumb, pagination, and `api.ref` citation links follow Astro's `trailingSlash`, so they match the canonical URL. Citation links now end in `/` under `"always"` and `"ignore"` instead of 404ing in `dev` and `preview`, and other links drop the slash under `"never"`.
- `noindex: true` pages are left out of the sitemap on sites without `base`, as they already were with `base`.
- The docs schema accepts Astro's `slug` frontmatter field, so a page in a `1.2.3/` folder can keep its dots: `slug: 1.2.3/setup` serves it at `/1.2.3/setup/`.
- API pages no longer return 500 ("missing prepared page data") in `astro dev` after the Astro config switches to server output while the dev server is running, for example after `add adapter-cloudflare`.

**Cloudflare**

- `add adapter-cloudflare` and new Cloudflare server scaffolds install `@astrojs/cloudflare` 14.3, which fixes a crash on the first `astro dev` with a cold cache ("Dev server process exited before becoming ready"). Existing sites can upgrade with `pnpm add @astrojs/cloudflare@~14.3.0`.
- `add adapter-cloudflare` names the policy it adds: `rendering: { default: "request" }`, which renders every collection on request. To render only API pages on request, set that policy before running the installer, which keeps an existing policy.

**CLI**

- CLI hints print a runnable command instead of a raw Node and `dist/` path. pnpm and Yarn projects with the package installed get the local bin, such as `pnpm nimbus-docs migrate`, instead of a `dlx` download.
- `check` warns about the placeholder `site` instead of failing, matching the build: set `site` before deploying. After `check --fix` without a terminal, it says the remaining fixes need one.
- `check` lists what it skipped when the `api` config or the rendering policy isn't a plain literal.
- `migrate --dry-run` exits `0` when no migrations or required reviews remain and a baseline is recorded, including when no entries fall between the recorded and installed versions, and says so instead of printing nothing.
- `outdated --json` counts only required entries in `summary.packageApis` and adds `summary.optionalPackageApis`. It warns in a new `warnings` array when the starter tag and installed package don't match, in either direction; only a starter that needs a newer package blocks `--apply`.
- `outdated` and `migrate` use the same terms: migrations and upgrade reviews.
- `lint --help` lists the lint rules.
- `add` suggests registering only the component you asked for in `src/components.ts`, not its dependencies.
- Sites upgrading from before 0.13.0 with a custom loader on an indexed collection now see the 0.13.0 `withNimbusMarkdown()` requirement in `migrate` and `outdated`.

**Recipes**

- The `api-reference` recipe no longer appends ` · API` to the overview page title; leaf pages keep it. Sites that installed the recipe can change the title in `src/pages/api/[...slug].astro` to ``title={page.kind === "api" ? page.title : `${page.title} · API`}``.
