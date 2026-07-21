---
{
  "name": "new-collection",
  "type": "registry:feature",
  "title": "Add a new collection",
  "description": "End-to-end setup for a non-version content tree on a Nimbus docs site — blog, API reference, changelog, glossary. Creates the folder, registers the collection, scaffolds routes. For docs versions, use `nimbus-docs add new-version`.",
  "markers": ["src/pages/<collection>/[...slug].astro"]
}
---

# Add a new collection

You are helping the user add a **non-version content tree** to a Nimbus
docs site — a blog at `/blog`, an API reference at `/api`, a changelog
at `/changelog`, a glossary at `/glossary`. Anything that lives
alongside the primary `docs` collection at its own URL prefix and is
NOT a frozen version of the docs.

**For docs versions, this is the wrong recipe.** A version (`docs-v1`,
`docs-2025-q1`, etc.) needs the version manifest, the picker install,
and picker wiring on top of what this recipe does. Use `nimbus-docs add
new-version` instead — it handles all of that. See section 5 below.

**For a feed-style changelog, this is also the wrong recipe.** This recipe
mounts a docs-shaped tree with a sidebar. A *changelog* — a dated,
reverse-chronological feed that renders entries inline with tag filtering and
an optional RSS feed — is a different shape. Use `nimbus-docs add changelog` for that.
Use this recipe only if the user explicitly wants a changelog rendered as a
plain doc tree.

**This recipe owns the whole setup of a non-version collection.** You
will create the content directory, register the collection in
`content.config.ts`, scaffold the page + `.md` alternate routes, and
optionally seed a starter entry. The user does not pre-create files or
edit configs — you do.

Read this entire file before making any changes.

## 1. Discovery (read-only)

Before prompting the user or writing anything, inspect the project to learn its
conventions:

- `package.json` — confirm `nimbus-docs` is a dependency. If not, stop and
  tell the user this isn't a Nimbus project.
- `src/content.config.ts` — read it in full. Note: (1) which collections
  already exist (you must not collide with them), (2) whether they use
  `docsCollection({ base: "..." })` from `nimbus-docs/content` so you can
  match their shape, (3) the `defineCollection`/`docsCollection` import
  layout already in place.
- `astro.config.ts` (or `nimbus.config.ts` if separate) — read the Nimbus
  config block (`defineNimbusConfig(...)`). Note: (1) the `sidebar.items`
  shape so you can describe a potential sidebar addition, (2) whether a
  `versions: {...}` block exists (relevant if the user picks a `docs-*`
  name).
- `src/pages/[...slug].astro` — read it. The new route will mirror this
  shape exactly except for the helper names (`getCollectionStaticPaths` /
  `getCollectionPageProps` instead of the `Docs` variants).
- `src/pages/[...slug]/index.md.ts` — read it. The new `.md` alternate
  will mirror it.
- `src/layouts/DocsLayout.astro` — confirm it exists. The new route uses
  it.
- `src/components.ts` — note which MDX globals are registered; the user's
  starter entry should only use these or plain markdown.

If any of the route files above are missing, the user is on a stripped-down
starter — stop and tell them to run `nimbus-docs add ai-native` first.

## 2. Prompt the user

Ask three questions, in this order. Use the user's prior answers to suggest
sensible defaults for the next.

### Q1. What's this collection for?

Free text. Common answers and how they map:

| Answer | Suggested collection name | Suggested URL prefix |
|---|---|---|
| "a blog" | `blog` | `/blog` |
| "API reference" / "API docs" | `api` | `/api` |
| "changelog" / "release notes" | `changelog` | `/changelog` |
| "glossary" | `glossary` | `/glossary` |
| "the old version of docs" / "v1" / "v2" | `docs-v1` (or `docs-v2`, etc.) | `/v1` (or `/v2`) — the slug after `docs-` |
| anything else | snake_or_kebab-case of the answer | same as the name |

### Q2. Confirm the collection name (default: the suggestion from Q1).

The collection name **must**:
- Be lowercase
- Contain only `a-z`, `0-9`, `-`, `_`
- Not collide with any existing collection in `content.config.ts`
- Not be `docs` or `partials` (reserved)
- Not start with `_` (the "loaded but excluded from indexing" prefix)

If the user picks a `docs-<slug>` name, note that — see step 5 about
versioning.

### Q3. Confirm the URL prefix (default: same as the collection name, or the
version slug if the collection is `docs-<slug>` and versioning is configured).

The URL prefix is the path segment the collection mounts under. For a `blog`
collection with prefix `/blog`, pages at `src/content/blog/foo.mdx` render at
`/blog/foo`. For a `docs-v1` collection with prefix `/v1`, pages render at
`/v1/foo`.

**Important convention:** when the collection name starts with `docs-`, the
URL prefix defaults to the part after `docs-`. This matches the versioning
URL convention — a `docs-v1` collection always mounts at `/v1/`, never at
`/docs-v1/`.

### Q4. Add a starter entry?

Default: **yes**. Most users want one MDX file to confirm the routes work
end-to-end before they write real content.

If yes, the file will be `src/content/<collection>/welcome.mdx` with minimal
frontmatter and one paragraph of body text explaining it's a placeholder.

## 3. Plan

Print a short, exact plan to the user **before** writing anything, listing:

- Files to create
- Existing files to edit (just `content.config.ts`; possibly
  `astro.config.ts` if versioning wiring is requested in step 5)
- The resulting URLs (e.g. `/blog/welcome`, `/blog/llms.txt`,
  `/blog/welcome/index.md`)

Wait for the user to confirm before executing.

## 4. Execute

In this order:

### 4a. Create the content directory + starter entry (if requested)

Create `src/content/<collection>/welcome.mdx`:

```mdx
---
title: Welcome
description: Placeholder entry created by `nimbus-docs add new-collection`. Replace with real content.
---

This is a placeholder entry for the `<collection>` collection. Replace this
file with your real content — the route at `/<prefix>/welcome` will pick up
your edits on next build.
```

Skip if the user declined a starter entry. (They'll need to create at least
one MDX file in `src/content/<collection>/` before the routes have anything
to render, but that's now their call.)

### 4b. Register the collection in `src/content.config.ts`

Add an entry to the `collections` object. Match the existing import style and
indentation. The new line:

```ts
"<collection>": defineCollection(docsCollection({ base: "<collection>" })),
```

**Two notes on this edit:**

- If the existing file uses unquoted shorthand keys (e.g. `docs: ...`,
  `partials: ...`), preserve that style for identifier-shaped names but
  **quote any name that contains hyphens** (e.g. `"docs-v1"` must be
  quoted — it's not a valid JS identifier).
- If `docsCollection` and/or `defineCollection` aren't already imported
  in this file, add the imports at the top. The standard imports for
  Nimbus are:

  ```ts
  import { defineCollection } from "astro:content";
  import { docsCollection } from "@cloudflare/nimbus-docs/content";
  ```

### 4c. Scaffold the page route

Write `src/pages/<prefix>/[...slug].astro`:

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
} from "@cloudflare/nimbus-docs";
import { components } from "../../components";

export const prerender = true;
export const getStaticPaths = getCollectionStaticPaths("<collection>");

const { entry, Content, headings } = await getCollectionPageProps<"<collection>">(Astro);

const currentSlug = Astro.url.pathname.replace(/\/$/, "") || "/";
// Pass collection so the sidebar/prev-next resolve against the current
// collection's tree. Critical for version pages — without this, version
// pages render the current docs sidebar with wrong prev/next.
const sidebar = await getSidebar(currentSlug, { collection: entry.collection });
const prevNext = await getPrevNext(currentSlug, {
  sidebarTree: sidebar,
  overrides: { prev: entry.data.prev, next: entry.data.next },
});
const breadcrumbs = await getBreadcrumbs(currentSlug);
const editUrl = await getEditUrl(entry);
const lastUpdated = entry.data.lastUpdated ?? await getLastUpdated(entry);
const toc = getTOC(headings, entry.data.tableOfContents);
const markdownPath = `/<prefix>/${entry.id}/index.md`;
const markdownUrl = Astro.site ? new URL(markdownPath, Astro.site).href : markdownPath;
const socialImage = entry.data.socialImage ?? `/og/<prefix>/${entry.id}.png`;
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

**The `collection` and `entryId` props are required, not optional.**
They drive cross-version `<link rel="alternate">`, `<link rel="canonical">`,
deprecation banner rendering, Pagefind facet emission, hidden-version
exclusion, and the per-version agent index hint. Omitting them turns
the new collection's routing into URL plumbing only — the SEO and
agent-discovery contract silently breaks. Always pass both.

Substitute `<collection>` (the collection name) and `<prefix>` (the URL
prefix) everywhere they appear. They are often the same string, but not
always (`docs-v1` collection → `v1` prefix).

If the user's primary `DocsLayout` accepts an `audience` prop or any other
field not listed above, mirror it. If it drops one of the props above, drop
that prop here too.

### 4d. Scaffold the `.md` alternate

Write `src/pages/<prefix>/[...slug]/index.md.ts`:

```ts
/**
 * Per-page /<prefix>/<slug>/index.md — clean markdown alternate for every
 * indexable entry of the `<collection>` collection. Mirrors the primary
 * .md alternate at src/pages/[...slug]/index.md.ts.
 */

import { getIndexedEntries, renderEntryAsMarkdown, type IndexedEntry } from "@cloudflare/nimbus-docs";
import { config } from "virtual:nimbus/config";

export const prerender = true;

const COLLECTION = "<collection>";

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

Substitute `<collection>` in the `COLLECTION` constant.

## 5. Adding a docs version? Stop and use `nimbus-docs add new-version`

If the user's intent is to add a **version of the docs** (a frozen
snapshot of v1 while they work on v2, an old release line they want to
keep navigable, etc.) — this is not the right recipe. Stop and tell
them:

> "It sounds like you want to add a docs version, not a generic
> collection. The `new-version` recipe is built for that — it does
> everything this recipe does, PLUS adds the version manifest, installs
> the picker, and wires it into your header and sidebar. Run
> `nimbus-docs add new-version` instead."

Then exit cleanly without making any edits.

How to detect: the user said something like "old version," "v1 / v2,"
"previous docs," or named the collection `docs-v1` / `docs-2025-q1` /
similar `docs-<slug>` pattern. When in doubt, ask.

This recipe is for **non-version** content trees: blogs, API references,
changelogs, glossaries, etc. Versioning is a separate first-class
feature with its own data layer (alternates table, deprecation, picker)
that needs more than route scaffolding.

## 6. Optional — add to the sidebar

If the user wants the new collection to appear in the site's sidebar, ask
before editing. Sidebar layout is taste-laden; don't unilaterally drop a new
group in.

If yes, find the `sidebar.items` array in the Nimbus config and add:

```ts
{ label: "<Display Name>", autogenerate: { collection: "<collection>" } },
```

Position it where the user wants — probably last for blog/changelog, first
or second for API reference.

## 7. Verify

After writing all files:

1. Run the user's build command — match their package manager (`pnpm`,
   `npm`, `yarn`).
2. Confirm the build completes without errors.
3. Confirm the dist output contains the expected files:
   - `dist/<prefix>/welcome/index.html` (if a starter entry was created)
   - `dist/<prefix>/welcome/index.md` (the .md alternate)
   - `dist/<prefix>/llms.txt` (emitted automatically when the collection
     has ≥ 1 entry)
   - The root `dist/llms.txt` lists `<prefix>` as a top-level section.
4. Tell the user the URLs they can visit:
   - `http://localhost:<port>/<prefix>/welcome` (HTML)
   - `http://localhost:<port>/<prefix>/welcome/index.md` (markdown)
   - `http://localhost:<port>/<prefix>/llms.txt` (agent index)

## 8. Already installed?

If `src/pages/<prefix>/[...slug].astro` already exists, do not overwrite it.
Ask the user whether to replace, skip, or show a diff first. The
`content.config.ts` entry may also already exist — check before editing.

## Notes for the agent

- This recipe is the **canonical way** to add any non-primary content tree
  to a Nimbus site. Blogs, API references, changelogs, glossaries, versioned
  docs siblings — all the same shape underneath.
- The framework helpers `getCollectionStaticPaths(collection)` and
  `getCollectionPageProps<C>(astro)` are sibling functions to
  `getDocsStaticPaths`/`getDocsPageProps`. Use the `Collection` variants in
  scaffolded routes; the `Docs` variants stay for the primary route only.
- The URL convention is intentional: primary `docs` mounts at root, every
  other collection mounts at `/<collection>/` or `/<version-slug>/` for
  version collections. The `getIndexedEntries()` / `getIndexedTopLevel()`
  helpers already know this convention; the routes you scaffold consume it.
- Do not try to register the collection automatically without the user's
  go-ahead in step 3 (the plan). The plan-then-confirm step is what turns
  this from an opaque codegen into a transparent edit.
