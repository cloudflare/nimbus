---
{
  "name": "content-overview",
  "type": "registry:feature",
  "title": "Recipe: Overview",
  "description": "Scaffold a product-area landing page — orient the reader in one paragraph, then route them everywhere else."
}
---

# Recipe: Overview

You are helping the user write an **overview** for their Nimbus docs site — the product-area landing page a reader lands on first and asks "What is this, and where do I start?" It orients in one paragraph, then routes. Read this entire file before writing.

The full, browsable version of this recipe, with the complete rationale, lives at <https://nimbus-docs.com/writing/recipes/overview> — and its agent-readable twin at <https://nimbus-docs.com/writing/recipes/overview/index.md>. Fetch it if you need more depth than this handoff carries.

## 1. Discovery

Inspect the repo before writing — do not assume:

- `package.json` — confirm this is a Nimbus project (depends on `nimbus-docs`).
- `src/components.ts` — the registered MDX components. Overviews lean on `CardGrid`/`Card` (the signature routing components) and `LinkCard` for link lists at volume. Use only registered components; install a missing one with `nimbus-docs add <slug>` and register it.
- `src/content.config.ts` — the docs collection's frontmatter schema, so you only emit fields the site accepts.
- `src/content/docs/` — where the page belongs; it's the file its sidebar section opens on, so match sibling folder and sidebar-order conventions.
- Ask the user for the real specifics (the product name, its plans/regions/stage, the quickstart route, the pages this area actually contains). Never invent product behavior.

## 2. When to use it

One overview per product or major product area — the page its sidebar section opens on. It's one of the two pages every area must have (with the quickstart). It is **not** a concept page (which explains how and why — move architecture and tradeoffs there and link them), **not** a bare table of contents (a list of links with no orientation is the sidebar duplicated into a page), and **not** a marketing page (the reader already clicked into the docs). A docs-site *home* spanning many areas is a lighter variant: same routing discipline, but the orientation shrinks to a tagline.

## 3. Title & description

- **Title:** the product or area name, as a noun — "Hookline," "Endpoints." Never "Hookline documentation," never a gerund, never "Introduction."
- **Description formula:** *What it is — what it does for whom.* — e.g. "Hookline delivers your application's webhooks — signed, retried, and observable."

## 4. Skeleton

```mdx
---
title: Hookline
description: Hookline delivers your application's webhooks — signed, retried, and observable.
type: overview
---

{/* Orientation: ONE paragraph. What the product does, for whom, in plain
    words. A reader who's in the wrong place should realize it here.
    Optionally follow with 3–4 bulleted outcomes ("what you can build") —
    still zero explanation. */}

{/* Availability: one line if it varies — plans, regions, release stage.
    Readers check eligibility before investing; don't make them find out
    at step 4 of the quickstart. */}

{/* Get-started CTA: the quickstart link, visually first among links. Two
    CTAs max if there are genuinely two entry paths (e.g. API vs dashboard). */}

{/* ## <Capability group> — one H2 per reader job (not org chart). Cards for
    a handful of entries, link lists at volume: */}

<CardGrid>
  <Card title="Send from your backend" href="/guides/send-events">
    The send() call, batching, idempotency keys.
  </Card>
  {/* …each card: name + one line + link. Cards route; they never explain. */}
</CardGrid>

{/* ## Related — only if adjacent areas are genuinely confusable with this
    one: each with one line on when to use it instead. Skip the section
    when there's nothing to disambiguate. */}

{/* Paths shown area-relative — prefix them when the area lives under a
    larger site. */}
```

## 5. Structure & components

- **Cards / CardGrid** are the signature components — this is the one type where cards *are* the body, because routing is the body. Keep each card to a name plus one line; a card that explains is a concept paragraph in a box. In the `.md` twin cards flatten to link-plus-description lists, so write one-liners that work in both forms.
- **Link lists** (`LinkCard` or prose lists) beat cards when the grid forces padded copy, or when a group must run past the ~5-link cap — prose scans better at volume.
- **Doesn't fit:** Steps (nothing is performed here), code blocks (nothing is looked up — inline code in the orientation line is fine), accordions (an overview hiding content is hiding its own map).
- **Ending:** end with **Related** when adjacent areas are genuinely confusable, each a one-line disambiguation; otherwise the last capability group ends the page. Either way, no "next steps" section — the entire page is next steps.
- **Thresholds:** orientation ≤ 1 paragraph (plus optional outcome bullets); 3–5 capability groups, ≤ ~5 links each; group by reader job ("Send events," "Secure"), never by internal team.

## 6. Write the page

Create `src/content/docs/<section>/<slug>.mdx` following the skeleton, adapted to the user's product and the site's registered components. The orientation paragraph must be self-contained and accurate on its own — it's what an agent quotes when asked "what is this." Every link is load-bearing: a broken or stale route here strands readers at the front door, so use real routes, not placeholders.

## 7. Verify

- Run the build, matching the user's package manager (`pnpm build`, `npm run build`, …); confirm it completes clean.
- If the site has lint configured, run `nimbus-docs lint`.
- Confirm every link resolves and new pages in this area are represented (or deliberately not).
- Self-review against the checklist below.

## Checklist

- [ ] Title is the product/area name, noun, no "documentation"
- [ ] One orientation paragraph (plus optional outcome bullets); a misplaced reader realizes it there
- [ ] Availability stated if it varies by plan/region/stage
- [ ] Quickstart CTA first among links
- [ ] Groups named by reader job; cards route, never explain
- [ ] Related present when confusable neighbors exist, with disambiguation lines
- [ ] Every link resolves; new pages in this area are represented (or deliberately not)
- [ ] No steps, no code blocks, nothing hidden in accordions

## Already have one?

If the target page already exists, do not overwrite it without confirming. Offer to review it against this recipe and suggest specific edits instead.
