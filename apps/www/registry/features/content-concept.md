---
{
  "name": "content-concept",
  "type": "registry:feature",
  "title": "Recipe: Concept",
  "description": "Scaffold an understanding page — what a thing is, why it works that way, and where its boundaries are."
}
---

# Recipe: Concept

You are helping the user write a **concept** page for their Nimbus docs site — an understanding page for a reader who can already operate the product (or is about to) and wants the mental model: what a thing *is*, why it's designed this way, where its boundaries are ("What is X, really?"). Read this entire file before writing.

The full, browsable version of this recipe, with the complete rationale, lives at <https://nimbus-docs.com/writing/recipes/concept> — and its agent-readable twin at <https://nimbus-docs.com/writing/recipes/concept/index.md>. Fetch it if you need more depth than this handoff carries.

## 1. Discovery

Inspect the repo before writing — do not assume:

- `package.json` — confirm this is a Nimbus project (depends on `nimbus-docs`).
- `src/components.ts` — the registered MDX components. Concepts lean on prose first, with `Aside`/`Callout` for asides, `Code` for illustrative payloads, and `Frame` for a diagram that carries a text equivalent. Use only registered components; install a missing one with `nimbus-docs add <slug>` and register it.
- `src/content.config.ts` — the docs collection's frontmatter schema, so you only emit fields the site accepts.
- `src/content/docs/` — where the page belongs; match sibling folder and sidebar-order conventions.
- Ask the user for the real specifics (the actual guarantee, tradeoff, or domain constraint). Never invent product behavior.

## 2. When to use it

Write a concept page when readers keep needing the same explanation in the middle of other pages — that's the signal the model deserves its own home. It is **not** a how-to (**the hard boundary: no procedural steps, no configuration walkthroughs** — illustrative code that *shows* the idea is welcome, code the reader follows along with is not), **not** reference (reference is complete and neutral; a concept is selective and opinionated — "we recommend" belongs here), and **not** an overview (the overview routes, the concept explains). One concept per page — "Delivery and signing" is two pages with a link between them.

The illustrative test for a borderline snippet: if removing it loses an *example*, it was illustrative; if removing it loses the *instructions*, it was a walkthrough and belongs in a how-to.

## 3. Title & description

- **Title:** a concise noun phrase naming the concept — "Delivery guarantees," "Webhook signing." Banned titles (GitLab's rule, worth adopting verbatim): "Overview," "Introduction," "How it works" — they name the genre, not the subject. Self-check: a good title still reads naturally with "About" in front of it ("About delivery guarantees" ✓).
- **Description formula:** *What the concept is, and what it means for the reader's code or choices.*

## 4. Skeleton

```mdx
---
title: Delivery guarantees
description: What Hookline guarantees about delivery — and what your endpoint must still handle itself.
type: concept
---

{/* Definition first — inverted pyramid. 1–2 paragraphs: what the thing is,
    in plain words, before any nuance. A reader who stops after paragraph
    one should leave with a correct (if shallow) model. */}

{/* ## Why it works this way — the rationale: for product-designed behavior,
    the constraint or tradeoff that shaped it ("we chose at-least-once
    because…" — opinion belongs here); for domain-inherent concepts (OAuth,
    pooling), the domain constraint plus your product's stance on it —
    don't re-derive what the field already documents, add your perspective
    (Cloudflare's rule). This section is what separates a concept page from
    a dictionary entry, and it's the section authors skip. */}

{/* ## <The model, unpacked> — 1–3 sections developing the idea: how the
    pieces relate, a diagram if one genuinely helps (with a text
    equivalent), illustrative code or payloads. One idea per section,
    each self-contained. */}

{/* ## Boundaries — where the concept stops: what it does NOT cover, common
    misreadings, and the neighbor concepts it's confused with. The
    comparison table lives here when there's a real either/or. */}

{/* ## See also — flat links: the how-tos that apply this concept, the
    reference that enumerates it. */}
```

## 5. Structure & components

- **Prose is the primary component.** Short paragraphs, one idea per section — this is the type where writing quality carries the page.
- **Diagrams and illustrative code/payloads** fit when they show the model; a diagram always ships with a text equivalent.
- **Comparison tables** fit in Boundaries when there's a genuine either/or.
- **Doesn't fit:** Steps (the defining ban — a concept has no procedural steps or walkthroughs), Tabs (a concept doesn't vary by platform; if it does, it's two concepts), Cards.
- **Ending, in order:** Boundaries → See also. Ending on scope — stating what the concept is *not*, next to its confusable neighbors — is the type's signature move and the cheapest way to make the model stick. Never end on the definition.
- **Thresholds:** a shallow-but-correct model by the end of paragraph two; at least one sentence of design rationale (a concept with no "why" is a glossary entry stretched to a page); ≤ ~1,500 words standalone (pages in an explicitly ordered core-concepts sequence meant to be read start-to-finish, like Tailwind's essay course, are exempt — a standalone concept that outgrows the cap splits in two).

## 6. Write the page

Create `src/content/docs/<section>/<slug>.mdx` following the skeleton, adapted to the user's product and the site's registered components. Lead with the contract in checkable terms ("at least once," "per-endpoint," "not ordered") rather than reassuring adjectives ("reliable," "robust") — the definition paragraphs are what gets retrieved and quoted, so they must stand alone. Keep illustrative payloads in fenced blocks with realistic values, and write Boundaries as flat declarative bullets.

## 7. Verify

- Run the build, matching the user's package manager (`pnpm build`, `npm run build`, …); confirm it completes clean.
- If the site has lint configured, run `pnpm exec nimbus-docs lint`.
- Self-review against the checklist below.

## Checklist

- [ ] Title is a noun phrase; not "Overview" / "Introduction" / "How it works"; passes the "About X" read-aloud test
- [ ] Definition first; correct shallow model by paragraph two
- [ ] Design rationale present — product tradeoff, or domain constraint + product stance
- [ ] Zero procedural steps or config walkthroughs; code passes the illustrative test
- [ ] Boundaries section: what it's not + confusable neighbors
- [ ] Diagram (if any) has a text equivalent
- [ ] Ends with See also linking the how-tos and reference that depend on this model
- [ ] ≤ ~1,500 words standalone (course-sequence pages exempt); one concept

## Already have one?

If the target page already exists, do not overwrite it without confirming. Offer to review it against this recipe and suggest specific edits instead.
