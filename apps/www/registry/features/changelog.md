---
{
  "name": "changelog",
  "type": "registry:feature",
  "title": "Changelog",
  "description": "Add a reverse-chronological changelog at /changelog — a dated timeline feed that renders full entries inline, with tag filtering, year-grouped load-more pagination, per-entry permalinks, OG cards, markdown alternates, and an optional RSS feed. Generic: tags are opaque strings you define. For a feed-style changelog; for a docs-shaped tree use `nimbus-docs add new-collection`.",
  "markers": ["src/content/changelog/", "src/pages/changelog/index.astro"]
}
---

# Changelog

You are helping the user add a **changelog** to their Nimbus docs site — a
reverse-chronological feed at `/changelog` that renders each entry's full
content inline on a timeline, with client-side tag filtering, year-grouped
load-more pagination, deep-linkable per-entry pages, OG cards, markdown
alternates for agents, and an optional RSS feed.

This is a distinct shape from `new-collection` (which mounts a docs-style
tree with a sidebar). A changelog is a dated feed. If the user wants a plain
content tree, stop and point them at `nimbus-docs add new-collection`.

The changelog is **a normal docs-shaped collection** with two extra
frontmatter fields (`date`, `tags`) — there is no bespoke changelog schema in
the framework. You wire it up with the existing `docsCollection({ schemaFields })`
helper (step 4). Read this entire file before making changes.

## 1. Discovery (read-only)

Inspect the repo to learn its conventions:

- `package.json` — confirm `nimbus-docs` is a dependency. Note the package
  manager. If not a Nimbus project, stop.
- `src/content.config.ts` — read it in full. Note the existing collections
  (you must not collide), and the `defineCollection` / `*Collection` import
  style already in place.
- `astro.config.ts` — read the Nimbus config. Note `sidebar.items` (you may
  offer to add a sidebar link in step 6 — ask first).
- `src/layouts/BaseLayout.astro` — confirm it exists and accepts
  `BasePageProps` (`title`, `description`, `head`, `noindex`, `socialImage`,
  `markdownUrl`, `collection`, `entryId`). ChangelogLayout wraps it.
- `src/components/Header.astro` — confirm it exists; ChangelogLayout renders
  it. Note whether it accepts `showSidebar`.
- `src/components.ts` — the MDX globals registry. Entry bodies render with
  this map, so authored components in entries work like they do in docs.
- `src/pages/og/[...slug].ts` and `src/pages/og/_og-card-config.ts` —
  the OG card setup. The starter uses `astro-og-canvas`; you will mirror it
  for the changelog (step 5l).
- `src/styles/globals.css` — confirm Nimbus tokens exist (`--nb-border`,
  `--nb-card`, `--nb-foreground`, `--nb-muted-foreground`, `--nb-h1-size`, …).
  The components use them.

**Required components.** The feed uses `<Badge>` (tag pills) and the
paginated route uses `<Pagination>`. If either is missing under
`src/components/ui/`, run `nimbus-docs add badge` and/or
`nimbus-docs add pagination` before continuing.

## 2. Prompt the user

Ask, with sensible defaults:

1. **Feed title and tagline** — default `Changelog` / "New features,
   improvements, and fixes." Shown in the hero.
2. **Page size** — how many entries before "load older". Default `20`.
3. **RSS feed?** — default **yes**. When yes, you'll add the `rss.xml` route,
   the `<head>` alternate link, and the RSS button in the hero. When no, skip
   all three (everything tagged "RSS only" below).
4. **Seed entries?** — default yes (one or two, so the routes render).

## 3. Plan

Print the exact file list before writing, and the resulting URLs
(`/changelog`, `/changelog/<slug>`, `/changelog/page/2`,
`/changelog/<slug>/index.md`, `/changelog/llms.txt`, and — if RSS was
chosen — `/changelog/rss.xml`). Wait for confirmation.

You will **create**:

- `src/content/changelog/<slug>.mdx` — seed entry/entries.
- `src/layouts/ChangelogLayout.astro`
- `src/components/changelog/ChangelogFeed.astro`
- `src/components/changelog/ChangelogEntry.astro`
- `src/components/changelog/DateRail.astro`
- `src/components/changelog/ChangelogFilter.astro`
- `src/components/changelog/changelog.client.ts`
- `src/pages/changelog/index.astro`
- `src/pages/changelog/[...slug].astro`
- `src/pages/changelog/page/[page].astro`
- `src/pages/changelog/[...slug]/index.md.ts`
- `src/pages/og/changelog/[...slug].ts`
- `src/pages/changelog/rss.xml.ts` — **RSS only** (skip if the user declined).

You will **edit**:

- `src/content.config.ts` — register the `changelog` collection.

You will **not** edit `astro.config.ts` automatically (sidebar is step 6).

## 4. Register the collection

A changelog is just a docs-shaped collection with two extra fields, so wire it
with the existing `docsCollection({ base, schemaFields })` helper — no special
framework schema. Add `changelog` to the `collections` object, preserving
existing entries and import style:

```ts
import { defineCollection, z } from "astro:content";
import { docsCollection } from "@cloudflare/nimbus-docs/content";

export const collections = {
  docs: defineCollection(docsCollection()),
  changelog: defineCollection(
    docsCollection({
      base: "changelog",
      schemaFields: {
        // `date` drives the reverse-chron sort + timeline marker.
        date: z.coerce.date({
          error: (iss) =>
            iss.input === undefined
              ? 'Missing required "date" in changelog frontmatter (e.g. 2026-06-16).'
              : '"date" must be a valid date (e.g. 2026-06-16).',
        }),
        // Opaque strings — the feed's filter derives its options from them.
        tags: z.array(z.string()).default([]),
      },
    }),
  ),
};
```

This gives entries `{ title, description?, date, tags }` plus the base docs
fields (`draft`, `noindex`, `socialImage`, `head`). `schemaFields` preserves
the types, so `entry.data.date` is a `Date` and `entry.data.tags` is
`string[]` in the routes below. Add more project fields (e.g.
`version: z.string().optional()`) the same way.

## 5. Implementation

Substitute the user's title/tagline/page-size where noted. The components
below are user-owned — restyle freely; they use only Nimbus tokens.

### 5a. `src/layouts/ChangelogLayout.astro`

```astro
---
/**
 * ChangelogLayout — single-column chrome for the changelog feed and its
 * per-entry permalink pages. A changelog is a feed, not a doc tree: no
 * sidebar, no TOC. Just the header and a centered reading column.
 */
import BaseLayout from "./BaseLayout.astro";
import Header from "@/components/Header.astro";
import type { BasePageProps } from "@cloudflare/nimbus-docs/types";

type Props = BasePageProps;

const baseProps = Astro.props;
---

<BaseLayout {...baseProps}>
  <div class="flex min-h-screen flex-col">
    <Header showSidebar={false} />
    {/* max-w-3xl (48rem) — a touch wider than the docs column. */}
    <main id="main-content" transition:name="nb-content" class="flex-1">
      <div class="mx-auto w-full max-w-3xl px-5 pt-10 pb-32 lg:px-8">
        <slot />
      </div>
    </main>
  </div>
</BaseLayout>

{/* These target MDX-rendered content (entry bodies marked `.nb-cl-prose`),
    which has no class hooks for Tailwind utilities — so they stay global. */}
<style is:global>
  .nb-cl-prose p {
    text-wrap: pretty;
  }

  /* Subtle 1px outline on entry images for consistent depth — pure
     black/white at 10%, never a tinted neutral. */
  .nb-cl-prose img {
    outline: 1px solid rgba(0, 0, 0, 0.1);
    outline-offset: -1px;
  }
  [data-mode="dark"] .nb-cl-prose img {
    outline-color: rgba(255, 255, 255, 0.1);
  }
</style>
```

If the project's `Header` does not accept `showSidebar`, drop the prop. The
`[data-mode="dark"]` selector matches the starter's theme attribute — adapt
if the project toggles dark mode differently.

### 5b. `src/components/changelog/DateRail.astro`

```astro
---
/**
 * DateRail — the date marker on the timeline. Renders the full date
 * ("Jun 12, 2026"); positioning is handled by the parent .nb-cl-entry
 * (see ChangelogFeed). The year is inline so the feed needs no year dividers.
 */
interface Props {
  date: Date;
}

const { date } = Astro.props;
const iso = date.toISOString().slice(0, 10);
const label = date.toLocaleDateString("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
---

<div class="nb-cl-rail">
  <time datetime={iso} class="nb-cl-date">{label}</time>
  <span class="nb-cl-dot" aria-hidden="true"></span>
</div>
```

### 5c. `src/components/changelog/ChangelogEntry.astro`

```astro
---
/**
 * ChangelogEntry — one entry in the feed. Renders the date marker, a
 * permalink title, tag pills, and the entry's full MDX body inline (rendered
 * with the site's MDX globals). `data-tags` feeds the filter; entries past
 * the initial page are `data-overflow` + hidden until "load older" reveals
 * them (older entries also reachable via /changelog/page/<n> with no JS).
 */
import { render } from "astro:content";
import type { CollectionEntry } from "astro:content";
import DateRail from "./DateRail.astro";
import { Badge } from "@/components/ui/badge";
import { components } from "@/components";

interface Props {
  entry: CollectionEntry<"changelog">;
  overflow?: boolean;
  /** Last visible entry — drops its trailing rail segment so the timeline
   *  closes at the final dot. The controller keeps this in sync. */
  railEnd?: boolean;
}

const { entry, overflow = false, railEnd = false } = Astro.props;
const { title, date, tags } = entry.data;
const href = `/changelog/${entry.id}`;
const { Content } = await render(entry);
---

<article
  class="nb-cl-entry"
  data-entry
  data-tags={tags.join(",")}
  data-overflow={overflow ? "" : undefined}
  data-rail-end={railEnd ? "" : undefined}
  hidden={overflow}
>
  <DateRail date={date} />

  {/* `nb-cl-title-link` / `nb-cl-title` stay class-based: the title's size is
      coupled to the rail's --cl-title-line, and the dot lights up via
      `:has(.nb-cl-title-link:hover)` — both live in ChangelogFeed's styles. */}
  <div>
    <a href={href} class="nb-cl-title-link">
      <h2 class="nb-cl-title">{title}</h2>
    </a>

    {
      tags.length > 0 && (
        <div class="mt-[0.6875rem] flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <Badge text={tag} variant="default" size="small" />
          ))}
        </div>
      )
    }

    <div class="docs-content nb-cl-prose mt-[1.125rem] max-w-none">
      <Content components={components} />
    </div>
  </div>
</article>
```

Note: the body is wrapped in `.docs-content` to inherit the project's prose
styles. If the project's prose root class differs, swap it.

### 5d. `src/components/changelog/ChangelogFeed.astro`

```astro
---
/**
 * ChangelogFeed — the reverse-chronological timeline. Sorts newest first and
 * renders every entry on one continuous rail. Each entry's date carries its
 * year, so there are no year dividers. Owns the timeline layout and the
 * "load older" control.
 */
import { Icon } from "astro-icon/components";
import type { CollectionEntry } from "astro:content";
import ChangelogEntry from "./ChangelogEntry.astro";

interface Props {
  entries: CollectionEntry<"changelog">[];
  pageSize?: number;
  loadMoreHref?: string;
}

const { entries, pageSize, loadMoreHref = "/changelog/page/2" } = Astro.props;

const sorted = [...entries].sort(
  (a, b) => b.data.date.getTime() - a.data.date.getTime(),
);

const cap = pageSize ?? sorted.length;
const hasOverflow = sorted.length > cap;
// Last initially-visible entry — its rail segment is dropped so the line ends
// at the final dot. The controller updates this as entries filter/reveal.
const lastVisibleIndex = Math.min(cap, sorted.length) - 1;
---

<div class="nb-cl-feed" data-changelog-feed data-page-size={pageSize ?? ""}>
  {
    sorted.map((entry, i) => (
      <ChangelogEntry entry={entry} overflow={i >= cap} railEnd={i === lastVisibleIndex} />
    ))
  }

  {/* `--body-x` aligns these with the entry content; they reset on mobile. */}
  <p
    class="pl-[var(--body-x)] pb-8 text-[0.9375rem] text-pretty text-muted-foreground max-sm:pl-0"
    data-changelog-empty
    hidden
  >
    No entries match the selected filter.
  </p>

  {
    hasOverflow && (
      <div class="mt-2 pl-[var(--body-x)] max-sm:pl-0">
        <a
          href={loadMoreHref}
          class="inline-flex items-center gap-[0.4375rem] rounded-[0.625rem] border border-border bg-card py-2 pr-3 pl-3.5 text-sm font-medium text-foreground no-underline transition-[background-color,border-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:border-border-strong hover:bg-accent active:scale-[0.97] motion-reduce:active:scale-100"
          data-load-more
        >
          <span>Load older entries</span>
          <Icon name="ph:arrow-down" class="h-4 w-4 text-muted-foreground" />
        </a>
      </div>
    )
  }
</div>

<script src="./changelog.client.ts"></script>

<style>
  /* Geometry is driven by three tokens so the date, dot, line, and content
     stay in lockstep — change one number, the whole rail re-aligns.
       --date-w   width of the right-aligned date column (left edge = 0)
       --rail-x   x of the vertical line + dot center
       --body-x   x where entry content begins */
  .nb-cl-feed {
    /* Wide enough for a full right-aligned date ("Jun 12, 2026"). */
    --date-w: 5.75rem;
    --rail-x: 6.5rem;
    --body-x: 8rem;
    /* Title's first line box (font 1.375rem × lh 1.25). The rail matches it
       so the date, dot, and title's first line share one horizontal axis. */
    --cl-title-line: calc(1.375rem * 1.25);
    position: relative;
  }

  /* On larger viewports, open up the gap between the rail and the entry
     content — only --body-x moves; the date, dot, and line stay put. */
  @media (min-width: 1024px) {
    .nb-cl-feed {
      --body-x: 10rem;
    }
  }

  :global(.nb-cl-entry) {
    position: relative;
    padding-left: var(--body-x);
    padding-bottom: 3.25rem;
  }
  /* Centered on the dot (translateX(-50%) at --rail-x); runs dot-center to
     dot-center so it threads every node. */
  :global(.nb-cl-entry)::before {
    content: "";
    position: absolute;
    left: var(--rail-x);
    top: calc(var(--cl-title-line) / 2);
    bottom: calc(var(--cl-title-line) / -2);
    width: 1px;
    transform: translateX(-50%);
    background: var(--nb-border);
  }
  /* Last visible entry: no next node to reach, so the rail runs to the bottom
     of the entry and fades out — a soft close-off for the end of the timeline. */
  :global(.nb-cl-entry[data-rail-end])::before {
    bottom: 0;
    background: linear-gradient(
      to bottom,
      var(--nb-border) 0,
      var(--nb-border) calc(100% - 4rem),
      transparent 100%
    );
  }

  /* Rail height = title's first line; centers its contents so the date sits
     on the same axis as the title. */
  :global(.nb-cl-rail) {
    position: absolute;
    left: 0;
    top: 0;
    width: var(--rail-x);
    height: var(--cl-title-line);
    display: flex;
    align-items: center;
  }
  :global(.nb-cl-date) {
    width: var(--date-w);
    text-align: right;
    font-size: 0.8125rem;
    font-weight: 500;
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
    color: var(--nb-muted-foreground);
    white-space: nowrap;
  }
  :global(.nb-cl-dot) {
    position: absolute;
    /* Dead-center of the rail box → on the title's axis and the line. */
    left: var(--rail-x);
    top: 50%;
    transform: translate(-50%, -50%);
    width: 9px;
    height: 9px;
    border-radius: 9999px;
    background: var(--nb-background);
    border: 1.5px solid var(--nb-border-strong);
    box-sizing: border-box;
    transition:
      border-color 160ms cubic-bezier(0.23, 1, 0.32, 1),
      background-color 160ms cubic-bezier(0.23, 1, 0.32, 1);
  }
  /* Light up the dot when its entry is hovered. */
  :global(.nb-cl-entry:has(.nb-cl-title-link:hover)) :global(.nb-cl-dot) {
    border-color: var(--nb-foreground);
    background-color: var(--nb-foreground);
  }

  /* Entry title — class-based because its size defines --cl-title-line (the
     rail's alignment unit) and it drives the dot's :has() hover above. */
  :global(.nb-cl-title-link) { display: inline-block; text-decoration: none; color: inherit; }
  :global(.nb-cl-title) {
    font-size: 1.375rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.25;
    color: var(--nb-foreground);
    margin: 0;
    text-wrap: balance;
  }
  :global(.nb-cl-title-link:hover .nb-cl-title) {
    text-decoration: underline;
    text-underline-offset: 3px;
    text-decoration-thickness: 1px;
  }

  @media (max-width: 640px) {
    :global(.nb-cl-entry) { padding-left: 0; padding-bottom: 2.75rem; }
    :global(.nb-cl-entry)::before,
    :global(.nb-cl-dot) { display: none; }
    :global(.nb-cl-rail) {
      position: static;
      display: block;
      width: auto;
      height: auto;
      margin-bottom: 0.5rem;
    }
    :global(.nb-cl-date) { width: auto; text-align: left; }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.nb-cl-dot) { transition: none; }
  }
</style>
```

### 5e. `src/components/changelog/ChangelogFilter.astro`

```astro
---
/**
 * ChangelogFilter — tag chips that filter the feed client-side. One toggle
 * per tag plus an "All" reset. The controller reads `data-filter-tag`,
 * toggles visibility, and syncs the selection to the URL (`?tag=`). Inert
 * with no JS (every entry stays visible).
 */
interface Props {
  tags: string[];
}

const { tags } = Astro.props;

// Tailwind v4 auto-gates `hover:` to `@media (hover: hover)`. `aria-pressed:`
// drives the selected state; `active:` gives press feedback (dropped under
// `motion-reduce:`).
const chip = [
  "inline-flex items-center min-h-8 cursor-pointer rounded-full border border-border",
  "px-3 py-1 text-[0.8125rem] font-medium leading-tight text-muted-foreground",
  "transition-[color,background-color,border-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
  "hover:text-foreground hover:border-border-strong",
  "active:scale-[0.96] motion-reduce:active:scale-100 motion-reduce:transition-colors",
  "aria-pressed:bg-foreground aria-pressed:text-background aria-pressed:border-foreground",
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-strong",
].join(" ");
---

{
  tags.length > 0 && (
    <div
      class="mt-7 flex flex-wrap gap-2"
      data-changelog-filter
      role="group"
      aria-label="Filter by tag"
    >
      <button type="button" class={chip} data-filter-tag="" aria-pressed="true">
        All
      </button>
      {tags.map((tag) => (
        <button type="button" class={chip} data-filter-tag={tag} aria-pressed="false">
          {tag}
        </button>
      ))}
    </div>
  )
}
```

### 5f. `src/components/changelog/changelog.client.ts`

```ts
/**
 * Changelog feed controller — progressive enhancement for tag filtering and
 * "load older" reveal. No framework; vanilla DOM. Re-inits on Astro view
 * transitions via `astro:page-load`.
 */

function initChangelog(): void {
  const feed = document.querySelector<HTMLElement>("[data-changelog-feed]");
  if (!feed) return;
  if (feed.dataset.clInit === "1") return;
  feed.dataset.clInit = "1";

  const entries = Array.from(feed.querySelectorAll<HTMLElement>("[data-entry]"));
  const emptyState = feed.querySelector<HTMLElement>("[data-changelog-empty]");
  const loadMore = feed.querySelector<HTMLAnchorElement>("[data-load-more]");
  const chips = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-filter-tag]"),
  );

  const pageSizeRaw = feed.dataset.pageSize ?? "";
  const pageSize = pageSizeRaw ? parseInt(pageSizeRaw, 10) : entries.length;
  const overflowEntries = entries.filter((e) => e.hasAttribute("data-overflow"));

  let activeTag = "";
  let revealed = 0;

  const entryTags = (el: HTMLElement): string[] =>
    (el.dataset.tags ?? "").split(",").filter(Boolean);
  const matches = (el: HTMLElement): boolean =>
    activeTag === "" || entryTags(el).includes(activeTag);

  function recompute(): void {
    const filtering = activeTag !== "";
    let visibleCount = 0;
    let lastVisible: HTMLElement | null = null;
    for (const el of entries) {
      const isOverflow = el.hasAttribute("data-overflow");
      let visible = matches(el);
      if (visible && !filtering && isOverflow) {
        visible = overflowEntries.indexOf(el) < revealed;
      }
      el.hidden = !visible;
      if (visible) {
        visibleCount += 1;
        lastVisible = el;
      }
    }
    // Close the rail at the last visible node — drop its dangling segment.
    for (const el of entries) {
      el.toggleAttribute("data-rail-end", el === lastVisible);
    }
    if (emptyState) emptyState.hidden = visibleCount > 0;
    if (loadMore) loadMore.hidden = filtering || revealed >= overflowEntries.length;
  }

  function setTag(tag: string): void {
    activeTag = tag;
    for (const chip of chips) {
      chip.setAttribute(
        "aria-pressed",
        (chip.dataset.filterTag ?? "") === tag ? "true" : "false",
      );
    }
    const url = new URL(window.location.href);
    if (tag) url.searchParams.set("tag", tag);
    else url.searchParams.delete("tag");
    window.history.replaceState({}, "", url);
    recompute();
  }

  for (const chip of chips) {
    chip.addEventListener("click", () => setTag(chip.dataset.filterTag ?? ""));
  }
  if (loadMore) {
    loadMore.addEventListener("click", (e) => {
      e.preventDefault();
      revealed = Math.min(revealed + pageSize, overflowEntries.length);
      recompute();
    });
  }

  const initialTag = new URL(window.location.href).searchParams.get("tag") ?? "";
  const known = chips.some((c) => (c.dataset.filterTag ?? "") === initialTag);
  if (initialTag && known) setTag(initialTag);
  else recompute();
}

document.addEventListener("DOMContentLoaded", initChangelog);
document.addEventListener("astro:page-load", initChangelog);
```

### 5g. `src/pages/changelog/index.astro`

Substitute the title, tagline, and `PAGE_SIZE`.

```astro
---
import { Icon } from "astro-icon/components";
import { getCollection } from "astro:content";
import ChangelogLayout from "@/layouts/ChangelogLayout.astro";
import ChangelogFeed from "@/components/changelog/ChangelogFeed.astro";
import ChangelogFilter from "@/components/changelog/ChangelogFilter.astro";

export const prerender = true;

const PAGE_SIZE = 20;

const entries = await getCollection("changelog", (e) => !e.data.draft);
const tags = [...new Set(entries.flatMap((e) => e.data.tags))].sort();

const title = "Changelog";
const description = "New features, improvements, and fixes.";
---

{/* RSS only — if the user declined RSS, drop the `head={[...]}` RSS link
    below and the RSS `<a>` button in the header. */}
<ChangelogLayout
  title={title}
  description={description}
  head={[
    {
      tag: "link",
      attrs: {
        rel: "alternate",
        type: "application/rss+xml",
        title: `${title} RSS`,
        href: "/changelog/rss.xml",
      },
    },
  ]}
>
  <header class="mb-14">
    <div class="flex items-center justify-between gap-4">
      {/* h1 token trio via inline style — site-wide page-title convention. */}
      <h1
        class="m-0 text-balance leading-[1.1] text-foreground"
        style="font-size:var(--nb-h1-size);font-weight:var(--nb-h1-weight);letter-spacing:var(--nb-h1-tracking)"
      >
        {title}
      </h1>
      {/* RSS only — omit this button if the user declined RSS. */}
      <a
        href="/changelog/rss.xml"
        class="inline-flex shrink-0 items-center gap-1.5 rounded-[0.625rem] border border-border py-1.5 pr-3 pl-2.5 text-[0.8125rem] font-medium text-muted-foreground no-underline transition-[color,border-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:border-border-strong hover:text-foreground active:scale-[0.97] motion-reduce:active:scale-100"
      >
        <Icon name="ph:rss" class="h-4 w-4" />
        <span>RSS</span>
      </a>
    </div>
    <p class="mt-2.5 text-pretty text-[1.0625rem] leading-normal text-muted-foreground">
      {description}
    </p>
    <ChangelogFilter tags={tags} />
  </header>

  <ChangelogFeed entries={entries} pageSize={PAGE_SIZE} />
</ChangelogLayout>
```

**If the user declined RSS:** delete the `head={[...]}` prop (leaving
`<ChangelogLayout title={title} description={description}>`) and remove the
RSS `<a>` button, so the header is just the title. Skip the `rss.xml.ts`
route in 5j entirely.

### 5h. `src/pages/changelog/[...slug].astro` (permalink)

```astro
---
import { Icon } from "astro-icon/components";
import ChangelogLayout from "@/layouts/ChangelogLayout.astro";
import { Badge } from "@/components/ui/badge";
import { getCollectionStaticPaths, getCollectionPageProps } from "@cloudflare/nimbus-docs";
import { components } from "@/components";

export const prerender = true;
export const getStaticPaths = getCollectionStaticPaths("changelog");

const { entry, Content } = await getCollectionPageProps<"changelog">(Astro);
const { title, description, date, tags } = entry.data;

const iso = date.toISOString().slice(0, 10);
const dateLabel = date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

const markdownPath = `/changelog/${entry.id}/index.md`;
const markdownUrl = Astro.site ? new URL(markdownPath, Astro.site).href : markdownPath;
const socialImage = entry.data.socialImage ?? `/og/changelog/${entry.id}.png`;
---

<ChangelogLayout
  title={title}
  description={description}
  markdownUrl={markdownUrl}
  socialImage={socialImage}
  noindex={entry.data.noindex}
  head={entry.data.head}
  collection={entry.collection}
  entryId={entry.id}
>
  <a
    href="/changelog"
    class="group mb-9 -ml-0.5 inline-flex items-center gap-1.5 text-[0.8125rem] font-medium text-muted-foreground no-underline transition-[color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:text-foreground active:scale-[0.98] motion-reduce:active:scale-100"
  >
    <Icon
      name="ph:arrow-left"
      class="h-4 w-4 transition-transform duration-[160ms] ease-[cubic-bezier(0.23,1,0.32,1)] group-hover:-translate-x-0.5 motion-reduce:transform-none"
    />
    <span>Changelog</span>
  </a>

  <article>
    <time datetime={iso} class="block text-[0.8125rem] font-medium tabular-nums text-muted-foreground">
      {dateLabel}
    </time>
    {/* h1 token trio via inline style — site convention. */}
    <h1
      class="mt-2 text-balance leading-[1.15] text-foreground"
      style="font-size:var(--nb-h1-size);font-weight:var(--nb-h1-weight);letter-spacing:var(--nb-h1-tracking)"
    >
      {title}
    </h1>

    {
      tags.length > 0 && (
        <div class="mt-4 flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <Badge text={tag} variant="default" size="small" />
          ))}
        </div>
      )
    }

    <div class="docs-content nb-cl-prose mt-9 max-w-none">
      <Content components={components} />
    </div>
  </article>
</ChangelogLayout>
```

### 5i. `src/pages/changelog/page/[page].astro` (paginated fallback)

The no-JS / crawler path to older entries. `PAGE_SIZE` **must be defined
inside `getStaticPaths`** — Astro runs it in an isolated scope. Keep it in
sync with `index.astro`.

```astro
---
import { getCollection } from "astro:content";
import ChangelogLayout from "@/layouts/ChangelogLayout.astro";
import ChangelogFeed from "@/components/changelog/ChangelogFeed.astro";
import { Pagination } from "@/components/ui/pagination";

export const prerender = true;

export async function getStaticPaths() {
  const PAGE_SIZE = 20;
  const entries = (await getCollection("changelog", (e) => !e.data.draft)).sort(
    (a, b) => b.data.date.getTime() - a.data.date.getTime(),
  );
  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const paths = [];
  for (let page = 2; page <= totalPages; page++) {
    paths.push({
      params: { page: String(page) },
      props: {
        slice: entries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
        page,
        totalPages,
      },
    });
  }
  return paths;
}

interface Props {
  slice: Awaited<ReturnType<typeof getCollection<"changelog">>>;
  page: number;
  totalPages: number;
}

const { slice, page, totalPages } = Astro.props as Props;
const prev = {
  label: page === 2 ? "Latest" : `Page ${page - 1}`,
  href: page === 2 ? "/changelog" : `/changelog/page/${page - 1}`,
};
const next =
  page < totalPages ? { label: `Page ${page + 1}`, href: `/changelog/page/${page + 1}` } : undefined;
---

<ChangelogLayout title={`Changelog — Page ${page}`} description="" noindex>
  <header class="mb-14">
    <a
      href="/changelog"
      class="mb-4 inline-block text-[0.8125rem] font-medium text-muted-foreground no-underline hover:text-foreground"
    >
      ← Latest
    </a>
    {/* h1 token trio via inline style — site convention. */}
    <h1
      class="m-0 leading-[1.1] text-foreground"
      style="font-size:var(--nb-h1-size);font-weight:var(--nb-h1-weight);letter-spacing:var(--nb-h1-tracking)"
    >
      Changelog
    </h1>
    <p class="mt-2.5 text-[1.0625rem] leading-normal text-muted-foreground">
      Page {page} of {totalPages}
    </p>
  </header>

  <ChangelogFeed entries={slice} />

  <div class="mt-12">
    <Pagination prevNext={{ prev, next }} />
  </div>
</ChangelogLayout>
```

### 5j. `src/pages/changelog/rss.xml.ts` — RSS only

Skip this entire step if the user declined RSS in step 2 (and make sure you
also dropped the `<head>` link + RSS button in 5g).

```ts
/**
 * /changelog/rss.xml — hand-rolled RSS 2.0 feed (no feed dependency).
 */
import { getCollection } from "astro:content";
import { config } from "virtual:nimbus/config";

export const prerender = true;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET() {
  const site = config.site ?? "http://localhost:4321";
  const feedUrl = new URL("/changelog/rss.xml", site).href;
  const channelLink = new URL("/changelog/", site).href;

  const entries = (await getCollection("changelog", (e) => !e.data.draft)).sort(
    (a, b) => b.data.date.getTime() - a.data.date.getTime(),
  );

  const items = entries
    .map((entry) => {
      const url = new URL(`/changelog/${entry.id}/`, site).href;
      const { title, description, date, tags } = entry.data;
      return [
        "    <item>",
        `      <title>${escapeXml(title)}</title>`,
        `      <link>${url}</link>`,
        `      <guid isPermaLink="true">${url}</guid>`,
        `      <pubDate>${date.toUTCString()}</pubDate>`,
        ...(description ? [`      <description>${escapeXml(description)}</description>`] : []),
        ...tags.map((t) => `      <category>${escapeXml(t)}</category>`),
        "    </item>",
      ].join("\n");
    })
    .join("\n");

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${escapeXml(config.title)} Changelog</title>`,
    `    <link>${channelLink}</link>`,
    `    <description>${escapeXml(config.description ?? "Changelog")}</description>`,
    "    <language>en</language>",
    `    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml" />`,
    items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");

  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
}
```

### 5k. `src/pages/changelog/[...slug]/index.md.ts` (markdown alternate)

```ts
/**
 * Per-entry `/changelog/<slug>/index.md` — the clean-markdown alternate.
 * Mirrors the primary docs alternate, scoped to the `changelog` collection,
 * adding the entry's date + tags to the frontmatter.
 */
import { getIndexedEntries, renderEntryAsMarkdown, type IndexedEntry } from "@cloudflare/nimbus-docs";
import { config } from "virtual:nimbus/config";

export const prerender = true;

const COLLECTION = "changelog";

interface SlugProps {
  item: IndexedEntry;
}

export async function getStaticPaths() {
  const indexed = await getIndexedEntries();
  return indexed
    .filter((item) => item.collection === COLLECTION)
    .map((item) => ({ params: { slug: item.entry.id }, props: { item } as SlugProps }));
}

export async function GET({ props }: { props: SlugProps }) {
  const { item } = props;
  const { entry, title, description, url } = item;
  const data = (entry.data ?? {}) as Record<string, unknown>;

  const date = data.date instanceof Date ? data.date.toISOString().slice(0, 10) : undefined;
  const tags = Array.isArray(data.tags) ? (data.tags as string[]) : [];

  const rawImage = data.socialImage;
  const socialImage =
    typeof rawImage === "string" && rawImage.length > 0 ? rawImage : config.socialImage;

  const markdown = renderEntryAsMarkdown(entry);

  const body = [
    "---",
    `title: ${JSON.stringify(title)}`,
    ...(description ? [`description: ${JSON.stringify(description)}`] : []),
    ...(date ? [`date: ${date}`] : []),
    ...(tags.length ? [`tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`] : []),
    ...(socialImage ? [`image: ${JSON.stringify(new URL(socialImage, config.site).href)}`] : []),
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

  return new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
```

### 5l. `src/pages/og/changelog/[...slug].ts` (OG cards)

Mirror the project's existing docs OG route for the changelog collection. For
the default starter (which uses `astro-og-canvas`):

```ts
import { getCollection } from "astro:content";
import { OGImageRoute } from "astro-og-canvas";
import { ogCardConfig } from "../_og-card-config";

const entries = await getCollection("changelog", (entry) => !entry.data.draft);

const pages = Object.fromEntries(
  entries.map((entry) => [
    entry.id,
    { title: entry.data.title, description: entry.data.description ?? "" },
  ]),
);

export const { getStaticPaths, GET } = await OGImageRoute({
  pages,
  param: "slug",
  getImageOptions: (_path, page) => ({
    title: page.title,
    description: page.description,
    ...ogCardConfig,
  }),
});
```

If the project uses a custom OG renderer instead, copy its docs OG route and
swap `getCollection("docs", …)` for `getCollection("changelog", …)`.

### 5m. Seed entry — `src/content/changelog/<YYYY-MM-DD>-welcome.mdx`

```mdx
---
title: Welcome to the changelog
description: This is a starter entry created by `nimbus-docs add changelog`. Replace it with your first real update.
date: 2026-01-01
tags:
  - announcement
---

This is a placeholder changelog entry. Each entry is one MDX file in
`src/content/changelog/` — set a `title`, a `date`, and optional `tags`, then
write the update in the body. Entries render newest-first on `/changelog`.
```

Use today's date. Authored components used in the body must be registered in
`src/components.ts` (same rule as docs).

## 6. Sidebar wiring (optional — ask first)

A changelog usually lives in the header or footer, not the docs sidebar. If
the user wants a link, ask where, then add to `astro.config.ts`:

```ts
{ label: "Changelog", link: "/changelog" }
```

Do not autogenerate a sidebar group from the collection — the feed is the
navigation.

## 7. Verify

1. Run the user's build command. Confirm it completes.
2. Confirm dist output:
   - `dist/changelog/index.html`, `dist/changelog/<slug>/index.html`
   - `dist/changelog/<slug>/index.md`
   - `dist/changelog/page/2/index.html` (only if entries exceed the page size)
   - `dist/changelog/llms.txt` and `changelog` listed in root `dist/llms.txt`
   - `dist/changelog/rss.xml` — only if RSS was chosen
3. In dev: `/changelog` shows the timeline; tag chips filter and sync `?tag=`;
   "load older" reveals more (when over the page size); a permalink renders.
   If RSS was chosen, `/changelog/rss.xml` is valid XML.

## 8. Already installed?

If `src/pages/changelog/index.astro` exists, do not overwrite. Ask whether to
replace, skip, or diff. The `content.config.ts` entry may also already
exist — check before editing.

## Notes for the agent

- There is no bespoke changelog schema in the framework — it's a normal
  `docsCollection({ schemaFields: { date, tags } })`. Everything here is
  user-owned source you can edit.
- `tags` are opaque strings — never hardcode a taxonomy. Filter options derive
  from the tags actually used.
- For a docs-shaped content tree (sidebar nav, not a feed), this is the wrong
  recipe — use `nimbus-docs add new-collection`.
