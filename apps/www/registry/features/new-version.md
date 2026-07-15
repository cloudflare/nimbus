---
{
  "name": "new-version",
  "type": "registry:feature",
  "title": "Add a docs version",
  "description": "End-to-end setup for adding a docs version to a Nimbus site. Creates the content directory, registers the collection, scaffolds routes, declares the manifest, installs the version-switcher picker, and wires it into your Header and DocsLayout. One command for one mental task.",
  "markers": ["src/pages/<version>/[...slug].astro", "src/components/ui/version-switcher/VersionPicker.astro"]
}
---

# Add a docs version

You are helping the user add a **version of the docs** to a Nimbus
site. A version is a frozen snapshot of the docs at a point in time:
the user is shipping v2 of their product and wants to keep v1's docs
navigable at `/v1/`, or they're cutting docs for a new API release
while preserving the old API's docs.

**This recipe owns the whole setup, end to end.** Adding a version
touches four concerns at once — content, collection registration, the
versioning manifest, the picker — and this recipe handles all of them
in a single conversation. The user does not pre-create files, edit
configs, or copy components manually.

Read this entire file before making any changes.

## 1. Discovery (read-only)

Before prompting the user or writing anything, inspect the project:

- `package.json` — confirm `nimbus-docs` is a dependency.
- `src/content.config.ts` — read in full. Capture all of:
  - The existing collections (you must not collide with names).
  - The import style (named imports vs default, `defineCollection`
    location).
  - Whether `docsCollection` from `nimbus-docs/content` is already
    imported.
  - **Whether the existing `docs` collection extends the schema via
    `schemaFields`**, e.g.

    ```ts
    docs: defineCollection(
      docsCollection({
        schemaFields: { audience: z.literal("human").optional() },
      }),
    ),
    ```

    If so, the new versioned collection MUST mirror those
    `schemaFields` — otherwise frontmatter validation diverges
    between current and the frozen version, and previously-valid
    pages will fail to build in the version collection. Capture the
    exact shape and reuse it in step 4b.
- `astro.config.ts` (or wherever `defineNimbusConfig(...)` lives) —
  read the Nimbus config. Note whether a `versions:` block already
  exists. If it does, the user is adding *another* version to an
  existing setup; if not, this is the first version.
- `src/pages/[...slug].astro` — the primary docs route. The new
  version's route will mirror its shape, including any custom prop
  forwarding. Specifically, scan its `<DocsLayout>` call for any
  `<field>={entry.data.<field>}` lines that aren't in the recipe's
  standard set (`title`, `description`, `sidebar`, `headings`,
  `breadcrumbs`, `prevNext`, `mode`, `banner`, `head`, `searchable`,
  `noindex`, `markdownUrl`, `socialImage`,
  `lastUpdated`, `editUrl`, `draft`, `collection`, `entryId`). Any
  extras almost certainly correspond to the `schemaFields` you'll
  capture below; they must be forwarded on the new version's route
  too (step 4d explains how).
- `src/pages/[...slug]/index.md.ts` — the primary `.md` alternate
  route. Same.
- `src/layouts/DocsLayout.astro` — must accept `collection` and
  `entryId` props and forward them. If those props are missing, the
  user is on an older starter; tell them to upgrade before continuing
  (the picker can't function without them).
- `src/components/Header.astro` — note whether `VersionPicker` is
  already imported. If yes, the picker is installed and this recipe
  only needs to register the new version; the existing picker will
  pick it up automatically. If no, this recipe will install and wire
  the picker.
- `src/components/ui/version-switcher/` — check if the directory
  exists. If yes, the component is already installed. If no, this
  recipe will copy it from the framework's registry.

If any of the primary docs routes or `DocsLayout.astro` are missing,
the user is on a stripped-down starter — stop and tell them to run
`nimbus-docs add ai-native` and ensure their layouts are up-to-date
first.

## 2. Prompt the user

Ask three to five questions in this order. Use prior answers to
default later ones.

### Q1. What version slug do you want? (no default)

The slug is the URL prefix. Common shapes:
- Major versions: `v0`, `v1`, `v2`, `v3` — best for SDKs / frameworks
- Calendar versions: `2024-q4`, `2025-q1` — best for APIs
- Named versions: `legacy`, `archive` — best when "v1 vs v2" overstates the change

Rules:
- Lowercase, `a-z` / `0-9` / `-` / `_` only — no dots, no spaces. The
  slug feeds into URLs.
- Must not equal the existing `versions.current` value (if one is set).

Tell the user the resulting URL prefix will be `/<slug>/<page>`.

### Q2. Is this the current version's label, or an older snapshot you're freezing? (default: older snapshot)

Two flows:

**(a) Freezing the current docs as `<slug>` (most common).** The user is
about to start work on a new major version. They want to snapshot
today's `src/content/docs/` as `<slug>` BEFORE editing. In this case,
you will:
- Copy `src/content/docs/*` → `src/content/docs-<slug>/*`
- Set the manifest's `current` to whatever LABEL the user wants for
  the new version they're about to start (e.g. they froze v1, they're
  starting v2, so `current: "v2"`).

**(b) Adding an older snapshot they have separately.** The user has
content for an older version they want to add. You will:
- Create an empty `src/content/docs-<slug>/` directory + a starter MDX
- The user pastes their content in afterwards
- Leave `current` as whatever it already is (or ask the user).

Confirm which flow before proceeding.

### Q3. If flow (a) — what's the LABEL for the version you're starting?

The user just froze `v1` as `<slug>=v1`. What's the new current
version's label? `v2` is the obvious default; ask before assuming.

### Q4. Should this version be marked deprecated?

Default: **no** (just freezing it normally).

If yes, the recipe adds `<slug>` to `versions.deprecated`. That
triggers:
- Yellow caution banner on every page in the version
- Pagefind search excludes the version from default results
- Picker shows a `deprecated` badge inline

Useful when the user is freezing an EOL version they want to keep
navigable but discourage.

### Q5. Should this version be hidden?

Default: **no**.

If yes, the recipe adds `<slug>` to `versions.hidden`. That means the
version's URLs resolve but it's excluded from:
- The picker dropdown
- Pagefind search index entirely
- `/llms.txt` (root + per-version)
- Cross-version `<link rel="alternate">` tags

Useful for in-progress drafts, marketing-published-but-incomplete
versions, or versions kept for one customer.

## 3. Plan

Print an exact plan before writing anything. Example:

> I'll do the following:
>
> 1. Copy `src/content/docs/*` → `src/content/docs-v1/*` (your current
>    docs become the frozen v1).
> 2. Add `"docs-v1": defineCollection(docsCollection({ base: "docs-v1" }))`
>    to `src/content.config.ts`.
> 3. Add to `astro.config.ts`:
>    ```ts
>    versions: {
>      current: "v2",
>      others: ["v1"],
>    }
>    ```
> 4. Write `src/pages/v1/[...slug].astro` (page route).
> 5. Write `src/pages/v1/[...slug]/index.md.ts` (markdown alternate).
> 6. Copy `VersionPicker.astro`, `index.ts`, and `README.md` into
>    `src/components/ui/version-switcher/`.
> 7. Edit `src/components/Header.astro` to render `<VersionPicker
>    collection={collection} entryId={entryId} />`.
> 8. Edit `src/layouts/DocsLayout.astro` to render the mobile picker
>    inside the sidebar drawer.
>
> Final result: visit `/` (v2 current) and `/v1/<page>` (frozen v1).
> The picker switches between them. Proceed?

Wait for explicit confirmation.

## 4. Execute

### 4a. Create the version's content directory

**For flow (a) — freezing current:**

```sh
cp -R src/content/docs/. src/content/docs-<slug>/
```

If `src/content/docs/` doesn't exist or is empty, tell the user there's
nothing to freeze and stop.

**For flow (b) — empty draft:**

```sh
mkdir -p src/content/docs-<slug>
```

Then write `src/content/docs-<slug>/welcome.mdx`. **Replace every
occurrence of `<slug>` below with the actual version slug the user
chose in Q1** (e.g. `v0`, `v1`, `2025-q1`). The file as written
contains four `<slug>` tokens — substitute all of them. Do not ship
literal `<slug>` angle brackets to the user's content:

```mdx
---
title: Welcome
description: Placeholder entry for the <slug> version. Replace with real content.
---

This is the `<slug>` version of the docs. Replace this file with your
real content.
```

### 4b. Register the collection in `src/content.config.ts`

Add to the `collections` object. If the existing `docs` collection
uses **plain `docsCollection`** with no schema extension, add:

```ts
"docs-<slug>": defineCollection(docsCollection({ base: "docs-<slug>" })),
```

If the existing `docs` collection has **custom `schemaFields`** (you
captured this in Discovery), mirror the entire `schemaFields` block
onto the new versioned collection:

```ts
"docs-<slug>": defineCollection(
  docsCollection({
    base: "docs-<slug>",
    schemaFields: { /* same shape as the docs collection's schemaFields */ },
  }),
),
```

Mirroring is required: a versioned collection without the same schema
extensions will fail to build any frozen page that uses those custom
frontmatter fields.

If `docsCollection` / `defineCollection` aren't imported in the file
yet, add the imports:

```ts
import { defineCollection } from "astro:content";
import { docsCollection } from "nimbus-docs/content";
```

### 4c. Declare or update the version manifest in `astro.config.ts`

Find the `defineNimbusConfig(...)` block. Two cases.

**Case A — no `versions` block yet.** Add one. Pick the matching
shape based on the user's answers to Q4 (deprecated) and Q5 (hidden):

*Neither deprecated nor hidden:*

```ts
versions: {
  current: "<current-label>",
  others: ["<slug>"],
},
```

*Deprecated only:*

```ts
versions: {
  current: "<current-label>",
  others: ["<slug>"],
  deprecated: ["<slug>"],
},
```

*Hidden only:*

```ts
versions: {
  current: "<current-label>",
  others: ["<slug>"],
  hidden: ["<slug>"],
},
```

*Both deprecated and hidden (rare):*

```ts
versions: {
  current: "<current-label>",
  others: ["<slug>"],
  deprecated: ["<slug>"],
  hidden: ["<slug>"],
},
```

In all four shapes, `<current-label>` comes from Q3 in flow (a) (the
label for the version the user is now starting work on), or from
the existing `current` value in flow (b).

**Case B — existing `versions` block.** Append `<slug>` to `others`.
If the user said yes to deprecation, also append to `deprecated`
(create the field if it doesn't exist yet). Same for `hidden`. Do
not touch `current` unless the user explicitly asked to bump it.

Example: if the existing block is

```ts
versions: { current: "v3", others: ["v2", "v1"], deprecated: ["v1"] }
```

…and the user is adding `v0` deprecated, edit to:

```ts
versions: { current: "v3", others: ["v2", "v1", "v0"], deprecated: ["v1", "v0"] }
```

### 4d. Scaffold the version's page route

**Helper choice — this is the #1 thing fresh agents get wrong here.**
The user's primary `src/pages/[...slug].astro` route uses
`getDocsStaticPaths` and `getDocsPageProps`. **Do not copy those.**
They are hardcoded to the primary `docs` collection. For any
non-primary collection (including every version), use the generic
siblings:

- `getCollectionStaticPaths("docs-<slug>")` — takes the collection
  name as an argument
- `getCollectionPageProps<"docs-<slug>">(Astro)` — takes the
  collection name as a TypeScript generic

The snippet below uses the correct helpers. Copy it verbatim and
substitute `<slug>` — do not be tempted to "match" the primary
route's `getDocs*` calls.

Write `src/pages/<slug>/[...slug].astro` (literal `<slug>` directory
name with the user's slug):

```astro
---
import DocsLayout from "../../layouts/DocsLayout.astro";
import {
  getCollectionStaticPaths,
  getCollectionPageProps,
  getSidebar,
  getPrevNext,
  getBreadcrumbs,
  getEditUrl,
  getLastUpdated,
  getTOC,
} from "nimbus-docs";
import { components } from "../../components";

export const prerender = true;
export const getStaticPaths = getCollectionStaticPaths("docs-<slug>");

const { entry, Content, headings } = await getCollectionPageProps<"docs-<slug>">(Astro);

const currentSlug = Astro.url.pathname.replace(/\/$/, "") || "/";
const sidebar = await getSidebar(currentSlug, { collection: entry.collection });
const prevNext = await getPrevNext(currentSlug, {
  sidebarTree: sidebar,
  overrides: { prev: entry.data.prev, next: entry.data.next },
});
const breadcrumbs = await getBreadcrumbs(currentSlug);
const editUrl = await getEditUrl(entry);
const lastUpdated = entry.data.lastUpdated ?? await getLastUpdated(entry);
const toc = getTOC(headings, entry.data.tableOfContents);
const markdownPath = `/<slug>/${entry.id}/index.md`;
const markdownUrl = Astro.site ? new URL(markdownPath, Astro.site).href : markdownPath;
const socialImage = entry.data.socialImage ?? `/og/<slug>/${entry.id}.png`;
---

<DocsLayout
  title={entry.data.title}
  description={entry.data.description}
  sidebar={sidebar}
  headings={toc}
  breadcrumbs={breadcrumbs}
  prevNext={prevNext}
  mode={entry.data.mode}
  banner={entry.data.banner}
  head={entry.data.head}
  searchable={entry.data.searchable}
  noindex={entry.data.noindex}
  markdownUrl={markdownUrl}
  socialImage={socialImage}
  lastUpdated={lastUpdated}
  editUrl={editUrl}
  draft={entry.data.draft}
  collection={entry.collection}
  entryId={entry.id}
>
  <Content components={components} />
</DocsLayout>
```

Substitute the user's version slug for **every `<slug>` token** in
the snippet above (the directory name in the file path, plus the
several references inside the file body). Don't ship literal angle
brackets to the user's repo.

The `collection={entry.collection}` and `entryId={entry.id}` props on
`<DocsLayout>` are required — they're what drives the picker, the
deprecation banner, the cross-version alternates, and the canonical
link. Do not omit them.

**If you captured custom `schemaFields` in Discovery (step 1), you
also need to forward the matching props to `<DocsLayout>`** —
otherwise the schema validates correctly but the values silently
never reach the UI. Open the primary route at
`src/pages/[...slug].astro` and look at its `<DocsLayout>` call. Any
custom-prop forwarding lines like `audience={entry.data.audience}`,
`<myField>={entry.data.<myField>}`, etc. that exist there must be
added to your new version route's `<DocsLayout>` call too. Example:
if the primary route has

```astro
<DocsLayout
  ...
  audience={entry.data.audience}
>
```

…add `audience={entry.data.audience}` to your `<DocsLayout>` here so
v0 pages with `audience: "human"` render the same "For humans"
treatment as v1 pages.

### 4e. Scaffold the version's `.md` alternate route

Write `src/pages/<slug>/[...slug]/index.md.ts`:

```ts
import { getIndexedEntries, renderEntryAsMarkdown, type IndexedEntry } from "nimbus-docs";
import { config } from "virtual:nimbus/config";

export const prerender = true;

const COLLECTION = "docs-<slug>";

interface SlugProps {
  item: IndexedEntry;
}

export async function getStaticPaths() {
  const indexed = await getIndexedEntries();
  return indexed
    .filter((item) => item.collection === COLLECTION)
    .map((item) => ({
      params: { slug: item.entry.id },
      props: { item } as SlugProps,
    }));
}

export async function GET({ props }: { props: SlugProps }) {
  const { item } = props;
  const { entry, title, description, url } = item;
  const data = (entry.data ?? {}) as Record<string, unknown>;
  const rawImage = data.socialImage;
  const socialImage =
    typeof rawImage === "string" && rawImage.length > 0
      ? rawImage
      : config.socialImage;

  const markdown = renderEntryAsMarkdown(entry);

  const body = [
    "---",
    `title: ${JSON.stringify(title)}`,
    ...(description ? [`description: ${JSON.stringify(description)}`] : []),
    ...(socialImage
      ? [`image: ${JSON.stringify(new URL(socialImage, config.site).href)}`]
      : []),
    "---",
    "",
    "> Documentation Index",
    `> Fetch the complete documentation index at: ${new URL("/llms.txt", config.site).href}`,
    "> Use this file to discover all available pages before exploring further.",
    "",
    `# ${title}`,
    "",
    markdown,
    "",
    `Source: ${new URL(`${url}/index.md`, config.site).href}`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
```

Substitute the user's version slug for every `<slug>` token in the
snippet above (the directory name in the file path, plus the
`COLLECTION` constant value at the top).

### 4f. Install the version-switcher picker (skip if already installed)

If `src/components/ui/version-switcher/` already exists, skip this
step — the component is already installed.

Otherwise, install it via the registry CLI:

```sh
nimbus-docs add version-switcher --yes
```

That command copies three files into the user's project:

```
src/components/ui/version-switcher/
├── VersionPicker.astro
├── index.ts
└── README.md
```

**If the CLI fails (404 from the registry, network error, etc.),
recover in this priority order:**

1. **You're testing this recipe pre-release inside the Nimbus
   monorepo.** The registry isn't deployed yet for the
   `version-switcher` slug. Recovery:

   ```sh
   # Terminal 1 (from monorepo root)
   pnpm --filter @nimbus/www generate-registry
   node apps/www/scripts/serve-registry.mjs
   # → [serve-registry] http://localhost:8901
   ```

   ```sh
   # Terminal 2
   export NIMBUS_REGISTRY_URL=http://localhost:8901
   pnpm exec nimbus-docs add version-switcher --yes
   ```

2. **You're a fresh user and the live registry is down or stale.**
   Fall back to copying the files directly from the framework's
   GitHub repo (the registry hosts the same content):

   ```sh
   curl -fsSL https://raw.githubusercontent.com/cloudflare/nimbus/main/packages/nimbus-starter-source/src/components/ui/version-switcher/VersionPicker.astro \
     -o src/components/ui/version-switcher/VersionPicker.astro
   curl -fsSL https://raw.githubusercontent.com/cloudflare/nimbus/main/packages/nimbus-starter-source/src/components/ui/version-switcher/index.ts \
     -o src/components/ui/version-switcher/index.ts
   curl -fsSL https://raw.githubusercontent.com/cloudflare/nimbus/main/packages/nimbus-starter-source/src/components/ui/version-switcher/README.md \
     -o src/components/ui/version-switcher/README.md
   ```

   (Create `src/components/ui/version-switcher/` first if it doesn't
   exist.)

3. **You're an agent running inside the Nimbus monorepo (file system
   access) and neither of the above is convenient.** Read the source
   directly:

   ```
   packages/nimbus-starter-source/src/components/ui/version-switcher/
   ```

   Copy `VersionPicker.astro`, `index.ts`, and `README.md` verbatim
   into the user's `src/components/ui/version-switcher/`.

Do NOT abandon the recipe at this step. If you can't get the picker
files in via ANY of these three paths, that's a bug — report it
specifically rather than silently skipping the picker (a "successful"
recipe run with no picker is the worst outcome).

### 4g. Wire the picker into Header and DocsLayout (skip if already wired)

**Edit `src/components/Header.astro`:**

If `VersionPicker` isn't already imported, add the import alongside
the other component imports:

```ts
import { VersionPicker } from "./ui/version-switcher";
```

If the file doesn't already accept `collection` / `entryId` as props,
add them at the top:

```ts
interface Props {
  collection?: string;
  entryId?: string;
}

const { collection, entryId } = Astro.props;
```

Then render `<VersionPicker collection={collection} entryId={entryId} />`
inside the right-side cluster of the header (typically next to
`<SearchTrigger />`):

```astro
<div class="flex items-center gap-2">
  <VersionPicker collection={collection} entryId={entryId} />
  {config.search !== false && <SearchTrigger />}
  {/* ... other header controls ... */}
</div>
```

**Edit `src/layouts/DocsLayout.astro`:**

Add the import alongside the others:

```ts
import { VersionPicker } from "@/components/ui/version-switcher";
```

Find the mobile sidebar drawer — the `<dialog data-mobile-sidebar>`
block. Inside it, there's a `<nav>` that renders the sidebar. The
starter ships this with a `hasSidebar` slot conditional that lets
parent layouts override the sidebar entirely:

```astro
<nav class="px-4 pb-8 pt-5">
  {hasSidebar ? <slot name="sidebar" /> : (
    <Fragment>
      <SidebarFilter />
      <Sidebar items={sidebar} />
    </Fragment>
  )}
</nav>
```

Add the picker as the **first child of the `<nav>`, BEFORE the
conditional.** That way it shows on every page regardless of
whether the parent provides a custom sidebar slot — matching the
desktop header's unconditional render:

```astro
<nav class="px-4 pb-8 pt-5">
  <VersionPicker collection={collection} entryId={entryId} variant="sidebar" />
  {hasSidebar ? <slot name="sidebar" /> : (
    <Fragment>
      <SidebarFilter />
      <Sidebar items={sidebar} />
    </Fragment>
  )}
</nav>
```

If the layout you're editing has NO `hasSidebar` conditional (older
starter or custom layout), just add the picker above the existing
sidebar/filter render. The placement principle is the same: picker
at the top of the drawer's nav region.

Confirm the layout already forwards `collection` and `entryId` to
`<Header />`:

```astro
{hasHeader ? <slot name="header" /> : <Header collection={collection} entryId={entryId} />}
```

If it doesn't, add the props. The picker can't compute per-page hrefs
without them.

## 5. Verify

After writing all files:

1. Run the user's build command (`pnpm build` / `npm run build` / `yarn build`).
2. Confirm the build completes without errors.
3. Confirm the dist output contains:
   - `dist/<slug>/welcome/index.html` (or the equivalent first entry)
   - `dist/<slug>/welcome/index.md`
   - `dist/<slug>/llms.txt` (if the version has ≥ 2 entries)
4. Tell the user the URLs to visit:
   - `http://localhost:<port>/` (current version)
   - `http://localhost:<port>/<slug>/<page>` (frozen version)
   - Click the picker in the header to switch between them.

If the user added `deprecated: true`, also confirm the yellow caution
banner renders on the frozen version's pages with a working link to the
current sibling.

## 6. Already installed?

If `src/pages/<slug>/[...slug].astro` already exists, this version is
already set up. Don't overwrite. Ask the user whether to:
- Skip and exit
- Update the manifest only (add to `versions.deprecated` or
  `versions.hidden`)
- Replace the existing routes (show a diff first)

## Notes for the agent

- **Versioning is one concept; this recipe is one command.** Don't
  split the user's mental task across multiple recipes. If `new-collection`
  could do half the job and version-switcher's manual wiring could do
  the other half, you'd be doing the user's UX a disservice. Own it
  end-to-end.
- The picker's `latest` tag automatically applies to whichever version
  is `current` in the manifest. The user doesn't need to configure it.
- The cross-version URL convention is fixed: current at root, others at
  `/<slug>/`. The recipe doesn't ask about this — it's the framework
  contract.
- Cross-version `<link rel="alternate">` and `<link rel="canonical">`
  tags are emitted automatically by `NimbusHead` once the `collection`
  and `entryId` props flow through the layout chain. Don't try to
  inject them manually.
