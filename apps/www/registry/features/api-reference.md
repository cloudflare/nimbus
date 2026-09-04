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
- The Nimbus config — inline in `astro.config.ts` for most projects, or split
  into a `nimbus.config.ts`. Read it; you'll add an `api` entry and, if it's
  still inline, extract it so `content.config.ts` can share the same list.
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
`/api`. It **must** be lowercase letters, digits, and dashes (`a-z0-9-`), must
not collide with an existing collection, and must not be `docs` or `partials`
(reserved). This recipe writes
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
- Declare the spec **once** in the Nimbus config (an `api` entry); if that config
  is still inline in `astro.config.ts`, extract it to a shared `nimbus.config.ts`
  so `src/content.config.ts` can derive the collection from the same list — no
  second spec declaration.
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

### 4b. Declare the spec once, in a shared Nimbus config

The spec is declared in exactly **one** place — the Nimbus config's `api[]`
array — and the content collection (4c) derives from it, so the two can never
drift. For `src/content.config.ts` to read that array without pulling the
integration into the content layer, the config must be its own module built with
the **side-effect-free** `defineConfig` entry.

If your Nimbus config is still inline in `astro.config.ts`, extract it into a
`nimbus.config.ts` at the project root:

```ts
// nimbus.config.ts
import { defineConfig } from "@cloudflare/nimbus-docs/config";

export default defineConfig({
  // …your existing site / title / etc…
  api: [{ collection: "api", spec: "./src/api/openapi.yaml" }],
});
```

Then import it in `astro.config.ts` (Astro's own `defineConfig` is unchanged):

```ts
import nimbus from "@cloudflare/nimbus-docs";
import nimbusConfig from "./nimbus.config";

// …integrations: [nimbus(nimbusConfig)] …
```

`spec` is the path from Q1, resolved from the project root (not the current
working directory — builds from a monorepo root or `--root` resolve correctly).
`spec` may also be an inline OpenAPI object. Add a `label` for a friendlier name
in build diagnostics; it defaults to the collection name. To mount more than one
spec, add more entries to the array and explicitly register each one in 4c.

> **Why the `/config` entry?** `@cloudflare/nimbus-docs/config` exports only the
> identity `defineConfig` with no side effects, so a `nimbus.config.ts` imported
> by BOTH `astro.config.ts` and the early `content.config.ts` graph never drags
> the integration (mdx/sitemap/…) into the content layer. Importing `defineConfig`
> from the main `@cloudflare/nimbus-docs` barrel would.

### 4c. Register the collection explicitly from that same config

In `src/content.config.ts`, import the config, find the entry selected in 4b,
and register it under an explicitly visible collection key. This keeps the spec
declaration in one place while allowing Nimbus's static collection-name parser
to include the API reference in agent indexes:

```ts
import { apiCollection } from "@cloudflare/nimbus-docs/content";
import nimbus from "../nimbus.config";

const apiConfig = nimbus.api?.find((entry) => entry.collection === "api");
if (!apiConfig) throw new Error('Missing the "api" entry in nimbus.config.ts');

export const collections = {
  // …docs, partials…
  api: defineCollection(apiCollection(apiConfig)),
};
```

The import path is relative to `src/content.config.ts` (`../nimbus.config` for a
root-level config). If Q2 chose another collection name, substitute it in the
lookup and the object key (quote the key if it contains a dash). For multiple
specs, add one explicit lookup and literal collection key per `api[]` entry;
Nimbus does not discover collection names hidden behind a dynamic spread.

### 4d. Scaffold the `.md` twin route

Write `src/pages/api/[...slug]/index.md.ts`. This is the clean-markdown
alternate for every API page — the render comes from Nimbus's emitter via
`renderIndexedEntryMarkdown` (which handles both prose and API collections), so
do **not** prepend a `# title`; the emitter already renders the page heading.

<!-- api-reference-fixture:src/pages/api/[...slug]/index.md.ts -->
```ts
/**
 * Per-page `/api/<slug>/index.md` - the clean-markdown alternate for every
 * entry of the `api` reference collection. Sibling to the primary-collection
 * twin at `pages/[...slug]/index.md.ts`; filtering to `api` keeps the two
 * rest routes from generating conflicting paths.
 */

import {
  getIndexedEntries,
  renderIndexedEntryMarkdown,
  type IndexedEntry,
  withBase,
} from "@cloudflare/nimbus-docs";
import { config } from "virtual:nimbus/config";

export const prerender = true;

const API_COLLECTION = "api";
const absoluteUrl = (path: string) =>
  new URL(withBase(path, import.meta.env.BASE_URL), config.site).href;

interface SlugProps {
  item: IndexedEntry;
}

export async function getStaticPaths() {
  const indexed = await getIndexedEntries();
  return indexed
    .filter((item) => item.collection === API_COLLECTION)
    .map((item) => ({
      // The root overview has entry id "index" -> emit at `/api/index.md`
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
      ? [`image: ${JSON.stringify(absoluteUrl(config.socialImage))}`]
      : []),
    ...(version ? [`version: ${JSON.stringify(version)}`] : []),
    "---",
    "",
    "> Documentation Index",
    `> Fetch the complete documentation index at: ${absoluteUrl("/llms.txt")}`,
    "> Use this file to discover all available pages before exploring further.",
    "",
    markdown,
    "",
    // API pages have no authored `.mdx` source, so `sourceUrl` is undefined -
    // fall back to the `.md` twin's own URL.
    `Source: ${absoluteUrl(sourceUrl ?? markdownUrl)}`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
```

### 4e. Scaffold the HTML route

The route is thin: `getApiStaticPaths` enumerates one path per page, and
`getApiRoute(Astro)` reads the page props and shared navigation prepared by the
content loader, then marks the current navigation path active. It never reads
or parses the OpenAPI source at request time. Hand both results to `ApiLayout`
(installed in 4a). `ApiLayout` composes `ApiSidebar` (verb chips +
active-section pruning), `ApiFieldRow` (recursive fields with type links), and
`ApiCodeRail` (server-generated code samples with a language switcher + a
response-example status toggle), rendering any page
kind — operation, schema, section, or the root overview. Everything it draws is
pre-resolved on the view-model; the components hold only the look.

`getApiPage` also returns the page's versioning identity — `collection`,
`version`, and `coordinate`. Threading them into `NimbusHead` emits the
canonical + cross-version alternates on the coordinate axis, and into
`ApiLayout` lights up the version picker and the deprecated-version banner. A
single-version spec returns `version: null`, so both features stay dormant with
no extra wiring.

`ApiLayout` renders the three-column region, not the document shell. The
generated starter's `BaseLayout` already owns metadata, global styles, search,
theme, agent directives, and page-wide copy-button wiring; its `Header` provides
the mobile-menu trigger. Compose the route through that normal shell as shown
below. If the project has replaced either component, adapt the imports and
markup to its equivalent shell while preserving every prop passed here.

Write `src/pages/api/[...slug].astro`:

<!-- api-reference-fixture:src/pages/api/[...slug].astro -->
```astro
---
import { getApiRoute, getApiStaticPaths } from "@cloudflare/nimbus-docs/runtime";
import Header from "@/components/Header.astro";
import { ApiLayout } from "@/components/ui/api-layout";
import BaseLayout from "@/layouts/BaseLayout.astro";

export const prerender = true;
export const getStaticPaths = getApiStaticPaths("api");

const result = await getApiRoute(Astro);
if (result instanceof Response) return result;
const { page, nav, collection, version, coordinate } = result;
const socialImage = `/og${page.href.replace(/\/$/, "")}.png`;
const title = page.kind === "api" ? page.title : `${page.title} · API`;
---

<BaseLayout
  {title}
  description={page.description}
  markdownUrl={page.markdownHref}
  socialImage={socialImage}
  collection={collection}
  apiVersion={version ?? undefined}
  coordinate={coordinate}
>
  <Header showSidebar collection={collection} />
  <ApiLayout page={page} nav={nav} collection={collection} version={version} coordinate={coordinate} />
</BaseLayout>
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
user whether to replace, skip, or show a diff first. The `nimbus.config` `api[]`
entry and the `content.config.ts` derive line may also already exist — check
before editing.
