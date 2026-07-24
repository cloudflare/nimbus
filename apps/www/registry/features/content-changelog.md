---
{
  "name": "content-changelog",
  "type": "registry:feature",
  "title": "Recipe: Changelog",
  "description": "Write changelog entries — dated, categorized records that flag breakage and deep-link into the docs."
}
---

# Recipe: Changelog

You are helping the user write a **changelog** for their Nimbus docs site — the record of change: dated, categorized entries that answer the maintainer's questions ("What changed, does it break me, and what do I do about it?") and correct an agent's stale priors. Read this entire file before writing.

The full, browsable version of this recipe, with the complete rationale, lives at <https://nimbus-docs.com/writing/recipes/changelog> — and its agent-readable twin at <https://nimbus-docs.com/writing/recipes/changelog/index.md>. Fetch it if you need more depth than this handoff carries.

## 1. Discovery

Inspect the repo before writing — do not assume:

- `package.json` — confirm this is a Nimbus project (depends on `nimbus-docs`).
- `src/components.ts` — the registered MDX components. Changelogs lean on `Badge` for the breaking flag on a heading line, `Aside`/`Callout` for the top-of-page policy note, and `Code`. Use only registered components; install a missing one with `nimbus-docs add <slug>` and register it.
- `src/content.config.ts` — the docs collection's frontmatter schema, so you only emit fields the site accepts.
- `src/content/docs/` — where the page belongs; match sibling folder and sidebar-order conventions.
- Ask the user for the real specifics (change titles, dates, affected fields, sunset dates, doc anchors to link). Never invent product behavior.

## 2. When to use it

One changelog per product (or per clearly versioned surface). Two load-bearing distinctions:

- **Record vs. policy** (the Stripe split): dated entries of what changed live here; how versioning works and how to migrate live on their own pages, linked from every breaking entry.
- **Two genres, pick by what the reader keys on:**
  - **Date-headed** — for a continuously shipped surface (the Cloudflare/Linear shape). Sections per release date; entries titled by the change.
  - **Version-headed** — for a versioned artifact (an SDK, a named API version): sections per version (`## [2.14.0] — 2026-06-18`, plus an `Unreleased` section for libraries). The entry rules apply *within* each version section. "What changed between 2.13 and 2.14?" is unanswerable in a date-headed log — if readers pin versions, head by version.

It is **not** a commit log (curated, benefit-first entries, not a dump of merge messages), **not** release marketing (an entry informs; link the launch post, don't replace the entry with it), and **not** a migration guide (an entry says *that* something breaks and links out; the steps are a how-to).

## 3. Title & description

- **Page title:** "Changelog" — the fixed, expected string.
- **Entry titles:** the change itself, specific and self-contained — "Retry backoff is now configurable per endpoint," not "Improvements to delivery" and not a bare version number (versions head sections, not entries).
- **Description formula (page):** *Every notable change to product, dated, with breaking changes flagged.*

## 4. Skeleton

```mdx
---
title: Changelog
description: Every notable change to Hookline, dated, with breaking changes flagged.
type: changelog
---

{/* Orientation: 1–2 lines — what "breaking" means here, link to the
    versioning policy and the subscription channels (RSS/email). */}

{/* ## YYYY-MM-DD (date-headed) or ## [X.Y.Z] — YYYY-MM-DD (version-headed).
    Within a section, one ### entry per change:

    ### <Specific change title>
    **<Category>** — 1–3 sentences: what changed and what it means for the
    reader — impact first, mechanism second. Categories: Added | Changed |
    Deprecated | Removed | Fixed | Security. Breaking entries open the body
    with a bold flag: **<Category> · Breaking, effective YYYY-MM-DD** —
    first line, not buried in the title, so scanners and feed readers
    catch it.
    Then: link the docs page describing the new state (for entries that
    change documented behavior); migration guide if breaking; launch post
    if one exists.

    Breaking entries additionally state: what breaks, who's affected,
    the deadline/sunset date. */}

{/* Entry headings are permalinks: never retitle a published entry without
    preserving its anchor. At multi-product scale, tag entries by product
    for filtering. */}

{/* Deprecations get TWO entries over their life: one when announced
    (Deprecated, with sunset date + migration link), one when removed
    (Removed). Never remove silently. */}
```

## 5. Structure & components

- **Section headings** (date or version) + **entry sub-headings** are the structure. The **breaking flag opens the entry body in bold** (`**Deprecated · Breaking, effective 2026-09-18**`) — first thing scanners and feed readers see, without polluting the heading's anchor. A `Badge` on the heading line can echo it.
- **Category labels** — the six standard categories (Added / Changed / Deprecated / Removed / Fixed / Security) as consistent bold prefixes — make the page filterable by eye and by machine.
- **Record vs. policy:** dated entries live here; the versioning policy and migration steps live on linked pages, cited from every breaking entry.
- **Doesn't fit:** Steps (migration steps live in the linked guide), Cards, screenshots (link the docs that show the new UI — screenshots in a changelog rot in place forever).
- **A changelog doesn't end; it accumulates.** The contract is at the *top* (policy link, subscription channels) and per-entry (links to the pages describing the new state). Published entries are never *silently* rewritten: if an entry turns out wrong, amend the original *and* publish a dated correction entry, so both the version-scanning upgrader and the timeline reader see it.
- **Thresholds:** entry body ≤ 3 sentences (depth lives on a linked page); entries that change documented behavior link to the updated docs page; every breaking/deprecation entry carries who's affected, what to do, and a date — missing any of the three, it isn't ready.

## 6. Write the page

Create `src/content/docs/<slug>.mdx` following the skeleton, adapted to the user's product and the site's registered components. Head sections by date or by version per the genre choice; title each entry by the change; prefix the category in bold; open breaking entries with the bold flag on the first body line. Deep-link entries into stable doc anchors — publishing an entry and updating the pages it links to is *one* act, not two. Use ISO dates (`2026-06-18`); "last month" is meaningless in a retrieved chunk. Keep each entry self-contained with full field and feature names, so an entry retrieved alone still makes sense — the changelog is the prior-correction surface where a Deprecated/Removed entry stops an agent from recommending the old thing.

## 7. Verify

- Run the build, matching the user's package manager (`pnpm build`, `npm run build`, …); confirm it completes clean.
- If the site has lint configured, run `pnpm exec nimbus-docs lint`.
- Self-review against the checklist below.

## Checklist

- [ ] Genre chosen deliberately: date-headed (continuous surface) or version-headed (pinned artifact, with Unreleased for libraries)
- [ ] Entries titled by the change, self-contained, reverse-chronological
- [ ] Categorized: Added / Changed / Deprecated / Removed / Fixed / Security
- [ ] Breaking flag opens the entry body, with who's-affected + what-to-do + date
- [ ] Deprecations announced and removed as two separate entries; never silent
- [ ] Behavior-changing entries link to the updated docs page (Fixed/Security link where a target exists)
- [ ] Entry bodies ≤ 3 sentences; impact before mechanism; depth on linked pages
- [ ] Linked docs pages already updated at publish time
- [ ] Corrections amend the original entry and add a dated correction entry
- [ ] Subscription channels (RSS at minimum) linked at the top; entry anchors stable

## Already have one?

If the changelog page already exists, do not overwrite it without confirming. Offer to review it against this recipe and suggest specific edits — or append the new entry to the existing sections instead. If the user instead wants to scaffold a changelog **system** (a dedicated collection plus layout) rather than write entries, that's the separate `nimbus-docs add changelog` feature.
