---
{
  "name": "api-reference",
  "type": "registry:feature",
  "title": "OpenAPI reference",
  "description": "Mount an OpenAPI (Swagger) spec as a routed reference collection — generated pages, per-page `.md` twins, and llms.txt/corpus coverage, all from one spec file. For hand-authored API docs written as MDX, use `new-collection` instead.",
  "markers": ["src/pages/api/[...slug].astro"]
}
---

# OpenAPI reference

You are helping the user mount an **OpenAPI (Swagger) spec** as a first-class
reference collection on a Nimbus docs site. One spec file in, and the user
gets: a routed page per operation/schema/tag under `/api`, a clean-markdown
`.md` twin for every page, and automatic llms.txt + corpus coverage so agents
can read the whole API surface.

The render is Nimbus's own — the spec is parsed once per build and projected
into a stable view-model. There is no third-party reference renderer.

**For hand-authored API docs, this is the wrong recipe.** If the user wants to
write their API docs by hand as MDX pages (prose, curated examples, no spec),
that's a plain content tree — use `nimbus-docs add new-collection` and pick
`api` as the collection name. This recipe is specifically for generating the
reference **from an OpenAPI document**.

Read this entire file before making any changes.

## 1. Discovery (read-only)

Before prompting the user or writing anything, inspect the project:

- `package.json` — confirm `@cloudflare/nimbus-docs` is a dependency. If not,
  stop and tell the user this isn't a Nimbus project. Note the package manager
  (`pnpm`/`npm`/`yarn`) from the lockfile so later commands match.
- `src/content.config.ts` — read it in full. Note the `defineCollection`
  import and the existing `collections` object shape so your edit matches.
- `astro.config.ts` (or wherever `defineNimbusConfig(...)` lives) — read the
  Nimbus config block. You will add an `api` key to it.
- `src/pages/[...slug].astro` and `src/pages/[...slug]/index.md.ts` — the
  primary docs page + `.md` twin. The API routes are siblings that mirror the
  twin's frontmatter/headers, so match their style.
- Locate the OpenAPI spec. Ask the user for its path if it isn't obvious
  (common: `src/api/openapi.yaml`, `openapi.json`, `api/spec.yaml`).

## 2. Prompt the user

### Q1. Where is the OpenAPI spec?

A local file path relative to the project root (e.g. `./src/api/openapi.yaml`).
YAML or JSON, OpenAPI 3.x or Swagger 2.0. Remote URLs are not supported in v1 —
if the user only has a URL, have them save it into the repo first.

### Q2. Confirm the collection name + URL prefix (default: `api`).

The collection name doubles as the URL prefix, so `api` mounts the reference at
`/api`. It **must** be lowercase `a-z0-9-_`, must not collide with an existing
collection, and must not be `docs` or `partials` (reserved). This recipe writes
its routes under `src/pages/<collection>/` — substitute your chosen name for
`api` everywhere below if it differs.

## 3. Plan

Print a short, exact plan to the user **before** writing anything:

- Install the reference layer — `nimbus-docs add api-layout` — which copies four
  owned, editable components into `src/components/ui/` (ApiLayout, ApiSidebar,
  ApiFieldRow, ApiCodeRail) with their registry deps (Badge, cn, …), and installs
  the API engine's peer packages: `@scalar/openapi-parser` (the spec parser) plus
  `openapi-sampler` and `@readme/httpsnippet` (the code-sample generators). These
  stay out of the framework bundle, so they only land when you mount a spec.
- Edit `astro.config.ts` — add the `api` key to the Nimbus config.
- Edit `src/content.config.ts` — register the `api` collection.
- Create `src/pages/api/[...slug].astro` and `src/pages/api/[...slug]/index.md.ts`.
- Resulting URLs: `/api` (overview), `/api/<slug>` (each page), the matching
  `/api/<slug>/index.md` twins, and `/api/llms.txt`.

Wait for confirmation before executing.

## 4. Execute

### 4a. Install the reference layer

Run the registry recipe — it copies four owned, editable components that render
the view-model, and installs the API engine's peer packages:

```sh
pnpm exec nimbus-docs add api-layout   # or: npm / yarn
```

This lands `ApiLayout`, `ApiSidebar`, `ApiFieldRow`, and `ApiCodeRail` under
`src/components/ui/` (with their Badge/cn registry deps), and installs three
optional peer packages of `@cloudflare/nimbus-docs`: `@scalar/openapi-parser`
(required to parse the spec — the build fails without it), plus `openapi-sampler`
and `@readme/httpsnippet` (the curl/TypeScript/Python sample generators). Nimbus
keeps these out of its bundle and lazy-loads them, so docs-only sites never
install them.

The components read the frozen view-model only (hrefs, anchors, flags, grouping
are all pre-resolved) and own nothing but their look — restyle them freely,
they're yours now. The route in 4e composes them.

Confirm your `src/styles/globals.css` carries the method-colour tokens
`--nb-m-get`, `--nb-m-post`, `--nb-m-put`, `--nb-m-delete`, and `--nb-m-other`
(with the four `[data-mode="dark"]` overrides). Sites scaffolded by
`create-nimbus-docs` already ship them; the sidebar method chip and the page
route pill share these tokens, so without them the method glyph/pill fall back to
`currentColor` (uncoloured) rather than the get→green / post→blue / put→orange /
delete→red palette.

If you're wiring the engine by hand instead of via this recipe, install those
peers yourself: `@scalar/openapi-parser` is required; the other two are optional
(their absence just omits code samples).

### 4b. Add the `api` key to the Nimbus config

In `astro.config.ts`, inside `defineNimbusConfig({ ... })`, add:

```ts
api: [{ collection: "api", spec: "./src/api/openapi.yaml" }],
```

`spec` is the path from Q1, resolved from the project root (not the current
working directory — builds from a monorepo root or `--root` resolve correctly).
`spec` may also be an inline OpenAPI object. Add a `label` if you want a
friendlier name in build diagnostics; it defaults to the collection name. To
mount more than one spec, add more entries to the array.

### 4c. Register the collection in `src/content.config.ts`

Add `apiCollection` to the `nimbus-docs/content` import and register the
collection. The name and spec **must** match the `astro.config.ts` entry from
4b — they're the single source of truth together:

```ts
import { apiCollection } from "@cloudflare/nimbus-docs/content";

// inside the `collections` object:
api: defineCollection(apiCollection({ collection: "api", spec: "./src/api/openapi.yaml" })),
```

### 4d. Scaffold the `.md` twin route

Write `src/pages/api/[...slug]/index.md.ts`. This is the clean-markdown
alternate for every API page — the render comes from Nimbus's emitter via
`renderIndexedEntryMarkdown` (which handles both prose and API collections), so
do **not** prepend a `# title`; the emitter already renders the page heading.

```ts
/**
 * Per-page `/api/<slug>/index.md` — the clean-markdown alternate for every
 * entry of the `api` reference collection. Sibling to the primary-collection
 * twin at `pages/[...slug]/index.md.ts`; filtering to `api` keeps the two
 * rest routes from generating conflicting paths.
 */

import {
  getIndexedEntries,
  renderIndexedEntryMarkdown,
  type IndexedEntry,
} from "@cloudflare/nimbus-docs";
import { config } from "virtual:nimbus/config";

export const prerender = true;

const API_COLLECTION = "api";

interface SlugProps {
  item: IndexedEntry;
}

export async function getStaticPaths() {
  const indexed = await getIndexedEntries();
  return indexed
    .filter((item) => item.collection === API_COLLECTION)
    .map((item) => ({
      // The root overview has entry id "index" → emit at `/api/index.md`
      // (undefined rest segment). Every other page emits at
      // `/api/<id>/index.md`.
      params: {
        slug: item.entry.id === "index" ? undefined : item.entry.id,
      },
      props: { item } as SlugProps,
    }));
}

export async function GET({ props }: { props: SlugProps }) {
  const { item } = props;
  const { title, description, markdownUrl, sourceUrl, version } = item;

  const markdown = await renderIndexedEntryMarkdown(item);

  const body = [
    "---",
    `title: ${JSON.stringify(title)}`,
    ...(description ? [`description: ${JSON.stringify(description)}`] : []),
    ...(config.socialImage
      ? [`image: ${JSON.stringify(new URL(config.socialImage, config.site).href)}`]
      : []),
    ...(version ? [`version: ${JSON.stringify(version)}`] : []),
    "---",
    "",
    "> Documentation Index",
    `> Fetch the complete documentation index at: ${new URL("/llms.txt", config.site).href}`,
    "> Use this file to discover all available pages before exploring further.",
    "",
    markdown,
    "",
    // API pages have no authored `.mdx` source, so `sourceUrl` is undefined —
    // fall back to the `.md` twin's own URL.
    `Source: ${new URL(sourceUrl ?? markdownUrl, config.site).href}`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
```

### 4e. Scaffold the HTML route

The route is thin: build the model, project the page props + nav, and hand both
to `ApiLayout` (installed in 4a). `ApiLayout` composes `ApiSidebar` (verb chips +
active-section pruning), `ApiFieldRow` (recursive fields with type links), and
`ApiCodeRail` (server-generated code samples with a language switcher + a
response-example status toggle), rendering any page
kind — operation, schema, section, or the root overview. Everything it draws is
pre-resolved on the view-model; the components hold only the look.

`ApiLayout` renders the three-column region, not the document shell — the page
supplies `<html>`/`<head>` and the site stylesheet, and a header of height
`3.5rem` so the layout's `sticky top-14` offsets line up. If your site already has
a base layout with a header + global styles, mount `<ApiLayout />` inside it
instead of the standalone shell below — and omit the shell's `codeCopy()`
`<script>` if that base layout already calls it (`BaseLayout` does), since two
`codeCopy()` calls stack a second copy button on every code block.

At `< lg` the nav lives in a left-slide drawer that `ApiLayout` opens from a
trigger marked `data-menu-btn` — without one, the API reference has no mobile
navigation. The standalone shell below includes a `lg:hidden` hamburger for this;
if you mount `ApiLayout` in your own base layout instead, render that layout's
menu trigger on the API route (in a `create-nimbus-docs` starter, pass
`<Header showSidebar />`). The starter's `globals.css` already hides a stray
`data-menu-btn` on pages with no drawer, so the trigger is safe to render
site-wide.

Write `src/pages/api/[...slug].astro`:

```astro
---
import "@/styles/globals.css";
import {
  getApiModel,
  getApiNav,
  getApiPageProps,
  getApiPageSlugs,
} from "@cloudflare/nimbus-docs/api";
import { ApiLayout } from "@/components/ui/api-layout";

const COLLECTION = "api";

export async function getStaticPaths() {
  // Inline the "api" literal here, NOT `COLLECTION` — Astro hoists
  // getStaticPaths above the frontmatter consts, so referencing them here
  // is a temporal-dead-zone error ("COLLECTION is not defined").
  const model = await getApiModel("api");
  return getApiPageSlugs(model).map(({ coordinate, slug }) => ({
    params: { slug: slug === "" ? undefined : slug },
    props: { coordinate },
  }));
}

const { coordinate } = Astro.props as { coordinate: string };
const model = await getApiModel(COLLECTION);
const page = getApiPageProps(model, coordinate);
const nav = getApiNav(model, coordinate);
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{page.title} · API</title>
    <link rel="alternate" type="text/markdown" href={page.markdownHref} />
  </head>
  <body class="bg-background text-foreground antialiased">
    <header class="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-6 backdrop-blur">
      <button
        type="button"
        data-menu-btn
        aria-label="Open navigation"
        class="-ml-1 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent lg:hidden"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M3 6h18M3 12h18M3 18h18" />
        </svg>
      </button>
      <a href="/api" class="font-mono text-sm font-semibold no-underline">{nav.collection}</a>
    </header>
    <ApiLayout page={page} nav={nav} />
  </body>
</html>

<script>
  // Page-wide copy buttons, wired once from the shell (not the component) so
  // every Shiki block — code rail and description fences alike — gets exactly
  // one button. See code-copy.ts: "Call codeCopy() once (e.g. from BaseLayout)."
  import { codeCopy } from "@cloudflare/nimbus-docs/client";
  codeCopy();
</script>
```

The nav is handled by `ApiSidebar` inside `ApiLayout` — there's no separate
`ApiNavList` to write. To customise the tree's look (icons, grouping, a
collapse-all affordance), edit `src/components/ui/api-sidebar/`; the active/
expanded flags and verb come pre-resolved on each `ApiNavItem`.
## 5. Optional — add to the sidebar

Sidebar layout is taste-laden; ask before editing. If the user wants an "API"
entry in the site sidebar, add a manual link to the `sidebar.items` array in
the Nimbus config (the API collection isn't a docs tree, so `autogenerate`
won't apply to it):

```ts
{ label: "API", link: "/api" },
```

## 6. Verify

After writing all files, run the user's build command and confirm:

1. The build logs `Indexed N API pages for "api".`
2. `dist/api/index.html` (overview) and `dist/api/<slug>/index.html` exist.
3. `dist/api/index.md` and `dist/api/<slug>/index.md` twins exist and contain
   the rendered reference (operation method/path, request body, responses).
4. `dist/api/llms.txt` lists every API page, and the root `dist/llms.txt`
   includes `api` as a top-level section.
5. `dist/llms-full.txt` (if the site emits a corpus) embeds the API markdown.

Then tell the user the URLs to visit: `/api`, `/api/<slug>`,
`/api/<slug>/index.md`, `/api/llms.txt`.

**Case-only coordinate collisions:** if the spec has two names that differ only
by case (e.g. `createResponse` and `CreateResponse`), Nimbus emits a build
diagnostic and disambiguates the slugs — but on a case-insensitive filesystem
(default macOS/Windows) the two `.md`/`.html` files collide on disk. It builds
fine on case-sensitive CI/hosting (Linux, Cloudflare). If a page looks missing
locally, this is why — rename in the spec or build on Linux.

## 7. Already installed?

If `src/pages/api/[...slug].astro` already exists, do not overwrite it. Ask the
user whether to replace, skip, or show a diff first. The `content.config.ts`
entry and the `api` config key may also already exist — check before editing.
