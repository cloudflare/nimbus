---
{
  "name": "content-reference",
  "type": "registry:feature",
  "title": "Recipe: Reference",
  "description": "Scaffold a lookup page — complete, neutral, rigidly templated, with the answer above the prose."
}
---

# Recipe: Reference

You are helping the user write a **reference** page for their Nimbus docs site — a lookup page whose reader enters sideways (search, an anchor link, an agent's retrieval), grabs one fact — a value, an option, a limit, a name — and leaves ("What are the exact values?"). Read this entire file before writing.

The full, browsable version of this recipe, with the complete rationale, lives at <https://nimbus-docs.com/writing/recipes/reference> — and its agent-readable twin at <https://nimbus-docs.com/writing/recipes/reference/index.md>. Fetch it if you need more depth than this handoff carries.

## 1. Discovery

Inspect the repo before writing — do not assume:

- `package.json` — confirm this is a Nimbus project (depends on `nimbus-docs`).
- `src/components.ts` — the registered MDX components. Reference leans on tables (its signature structure), `Code` for minimal examples, `Aside`/`Callout` sparingly, and `Badge` for definition lines. Use only registered components; install a missing one with `nimbus-docs add <slug>` and register it.
- `src/content.config.ts` — the docs collection's frontmatter schema, so you only emit fields the site accepts.
- `src/content/docs/` — where the page belongs; match sibling folder and sidebar-order conventions.
- Find the source of truth. If the facts live in code or schema, generate values from it — never hand-copy machine truths. Ask the user for the real values (fields, defaults, ranges, event types, limits). Never invent product behavior.

## 2. When to use it

Reference is an enumeration of facts about one nameable surface (a file format, a command, a set of types or limits). It is **not** a how-to (reference describes, never instructs — a "to do this, first…" entry means extract a how-to and link it), **not** a concept (opinion and rationale live there; one orienting sentence with a concept link is the whole prose allowance at the top), and **not** a dumping ground ("Miscellaneous" is where facts go to become unfindable). One surface per page; its structure mirrors the product's structure.

The two laws of the type: **completeness** (a missing entry breaks a reference the way a missing word breaks a dictionary) and **uniformity** (every entry answers the same questions in the same order).

## 3. Title & description

- **Title:** the surface's name, as the reader searches for it — "hookline.config.js," "CLI commands," "Event types," "Limits." Add "reference" only when the bare noun is ambiguous ("Retry policy reference").
- **Description formula:** *Every entry kind the surface accepts, with the fact categories listed.* — e.g. "Every field hookline.config.js accepts — type, default, and constraints."

## 4. Skeleton

```mdx
---
title: hookline.config.js
description: Every field hookline.config.js accepts — type, default, and constraints.
type: reference
---

{/* Source of truth: if these facts live in code/schema, generate this page
    from it; until generation exists, name the source in a comment here so
    maintainers know what to diff against. */}

{/* Orientation: 1–2 sentences — what this surface is, one link to the
    concept page that explains it. Then get out of the way. */}

{/* Quick-reference table above the entries — the whole surface at a glance:
    name | type | default | one-line purpose. The common lookup ends here
    with zero scrolling. It duplicates the entries' facts, so treat it as a
    projection: generate it from the entries/schema, or accept it as the
    page's highest-maintenance element. Skip if the surface has < ~5 entries. */}

{/* ## <Entry> — one H2 per entry, heading = the full self-identifying name
    (dotted path: retry.max_attempts). Nest headings only when the surface
    itself nests deeply; pick one depth and keep it across the whole set.
    Order: the surface's own order where it has one (file layout, command
    groups); for unordered surfaces (flags, env vars), most-used first, then
    alphabetical — and say which in the orientation line.
    Every entry, same internal template:
      - definition line: type · default · required? · constraints/range
      - description: neutral, ≤ 3 sentences of prose. Enumerable facts that
        need more (per-enum-value meanings, interactions, caveats) go in a
        list or sub-table under the entry — never a fourth sentence of prose.
      - a minimal example showing the entry in use */}

{/* Boilerplate tail (optional, identical on every page of the set):
    e.g. "## Environment overrides" — parameterized repetition beats DRY;
    generate it, don't hand-copy it. */}
```

Adapt the definition line per surface: config field carries *type · default · required · range*; a CLI flag carries *long form as heading, alias inline · value syntax · default · repeatable?*; an event type carries *payload schema link · when it fires · delivery guarantees*; a limit carries *value · scope · what happens at the limit · adjustable?*.

## 5. Structure & components

- **Tables are the signature component.** The quick-reference table above the entries makes the common lookup zero-scroll (Tailwind's utility pages are the purest case; Vite and Astro skip it and lean on the TOC, which works but makes every lookup a jump). Simple tables only — merged cells and meaning-by-layout break both scanning and extraction.
- **Definition lines** (type · default · constraints) in a fixed order — bold or badge them consistently.
- **Doesn't fit:** Steps, Cards, and callouts (a fact needing a warning usually belongs *in* the entry as a constraint), plus tabs or accordions that hide entries — a collapsed entry is invisible to search-and-grab readers and to extraction. The `.md` twin needs no special handling *because* nothing is hidden; the twin of a reference page is the page.
- **Ending:** reference pages don't end — they stop after the last entry (plus the boilerplate tail, if any). No next-steps footer; the reader who got their value already left, and the one who didn't needs the concept link at the top.
- **Thresholds:** complete or clearly scoped, nothing in between — if a subset lives elsewhere, line one says where. Entry prose ≤ 3 sentences, neutral, overflow into lists/sub-tables. One surface per page; ~30 entries is the signal to consider splitting along the surface's own seams (Astro keeps ~85 config entries on one page; Vite splits the same kind — never split alphabetically). Facts have exactly one source: generate values that live in code or schema; hand-maintained fact pages (limits, quotas) carry a visible `lastVerified` date.

## 6. Write the page

Create `src/content/docs/<section>/<slug>.mdx` following the skeleton, adapted to the user's product and the site's registered components. Every entry must be self-contained: the heading carries the full dotted path (`retry.max_attempts`, not "max_attempts" under a "Retry" heading), so a retrieved chunk carries its own identity. State ranges and defaults as machine-checkable values, never "a reasonable number." Keep examples minimal and in fenced blocks with realistic values.

## 7. Verify

- Run the build, matching the user's package manager (`pnpm build`, `npm run build`, …); confirm it completes clean.
- If the site has lint configured, run `pnpm exec nimbus-docs lint`.
- Self-review against the checklist below.

## Checklist

- [ ] Quick-reference table above the entries (surfaces ≥ ~5 entries), generated or consciously maintained
- [ ] Every entry present, or the scope exclusion stated in line one
- [ ] Every entry follows the same internal template, at the same heading depth
- [ ] Definition lines carry type · default · required · constraints (adapted per surface kind)
- [ ] Descriptions neutral; overflow facts in lists/sub-tables, not prose
- [ ] Entry headings carry full self-identifying names (dotted paths)
- [ ] Ordering stated or self-evident; anchors stable across edits
- [ ] Source of truth named (or the page is generated from it); hand-maintained fact pages carry `lastVerified`
- [ ] No steps, no opinions, nothing hidden in collapsed components

## Already have one?

If the target page already exists, do not overwrite it without confirming. Offer to review it against this recipe and suggest specific edits instead.
