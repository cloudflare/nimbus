---
{
  "name": "content-tutorial",
  "type": "registry:feature",
  "title": "Recipe: Tutorial",
  "description": "Scaffold a lesson — numbered parts that build one real project, teacher-owned, every stage producing a visible result."
}
---

# Recipe: Tutorial

You are helping the user write a **tutorial** for their Nimbus docs site — a lesson that takes a newcomer from nothing to a working project, where the teacher carries **all** responsibility and every stage produces a visible result ("Teach me to build something real with this"). Read this entire file before writing.

The full, browsable version of this recipe, with the complete rationale, lives at <https://nimbus-docs.com/writing/recipes/tutorial> — and its agent-readable twin at <https://nimbus-docs.com/writing/recipes/tutorial/index.md>. Fetch it if you need more depth than this handoff carries.

## 1. Discovery

Inspect the repo before writing — do not assume:

- `package.json` — confirm this is a Nimbus project (depends on `nimbus-docs`).
- `src/components.ts` — the registered MDX components. Tutorials lean on `Steps`/`Step` (or numbered `##` parts), fenced code blocks for the verbatim "You should see" output, `PackageManagers` for pinned install commands, and `Aside` used sparingly. Tabs exist but tutorials avoid them (one path, zero alternatives). Use only registered components; install a missing one with `nimbus-docs add <slug>` and register it.
- `src/content.config.ts` — the docs collection's frontmatter schema, so you only emit fields the site accepts.
- `src/content/docs/` — where the page belongs; match sibling folder and sidebar-order conventions.
- Ask the user for the real specifics (commands, pinned versions, expected output, what's mocked). Never invent product behavior.

## 2. When to use it

Write a tutorial when competence requires *assembling* the product's pieces — a platform or API whose value shows only when several features work together. Know the cost first: this is the most expensive type to build and keep true, because it must work for every reader, every time, on a cold machine. Fewest and freshest wins — one tested tutorial beats five stale ones, and a broken tutorial convinces a newcomer the *product* is broken. You may not need one at all: app-like products and single-concern tools often don't (Linear and Tailwind ship none) — a good quickstart plus how-tos covers them.

It is **not** a quickstart (proves the product works in minutes; the tutorial builds competence through a meaningful project in an hour), **not** a how-to (which serves a competent reader who carries themselves; here the reader knows nothing and when something breaks it is the tutorial's fault, never the reader's), and **not** a concept course (teach by doing, not explaining). One path, zero alternatives — the author already chose. When different stacks genuinely need different narratives, stamp one tutorial per stack (sibling pages beat variant tabs when the *whole story* differs).

## 3. Title & description

- **Title: "Build \<the thing\>"** — named by the outcome: "Build an order-notification service." Not "Learn Hookline," not "Tutorial 1."
- **Description formula:** *What you'll build, and what you'll be able to do afterward. Time estimate.* — e.g. "Build a service that emails customers when orders ship. Afterward you'll know Hookline's full send-deliver-verify loop. About 30 minutes."

## 4. Skeleton

```mdx
---
title: Build an order-notification service
description: Build a service that emails customers when orders ship. Afterward you'll know Hookline's full send-deliver-verify loop. About 30 minutes.
type: tutorial
lastVerified: 2026-07-06
---

{/* Overview: show the DESTINATION first — what the finished thing looks like
    (screenshot, output, demo), then:
    - "In this tutorial you will:" — 3–5 learning objectives as bullets
    - an honest time estimate, plus a concrete difficulty proxy (lines of
      code, services touched) — concrete beats beginner/intermediate labels */}

{/* ## Before you begin — prerequisites as checkable facts, PLUS pinned
    versions ("@hookline/sdk 3.2") — a tutorial that floats on latest
    breaks on a schedule. Name what's mocked ("we log the email instead
    of sending it") so the promise stays honest. */}

{/* ## 1. <First part> … ## N. <Nth part> — numbered parts, each one
    coherent stage of the build. Per part:
    - full-context heading (self-contained — a reader or agent landing
      mid-tutorial can tell where they are; never "Break it on purpose")
    - narration and transitions in first-person plural ("we'll wire the
      sender next"); instructions stay imperative ("Create the project")
    - EVERY part ends with a visible result and shows it verbatim —
      the "narrative of the expected": "You should see: …"
    - error-recovery as plain prose at the likely stumbles: "If you see X,
      it means Y — do Z" (anticipated, not exhaustive; no exception
      callouts — errors are happy-path content here)
    - explanation ≤ 2 sentences per occurrence; link the concept instead */}

{/* Optionally, one late part that STAGES a failure the reader will meet in
    production and shows the recovery — the teacher injects the failure, so
    reliability is preserved while the reader experiences the guarantee
    instead of reading about it. */}

{/* ## Clean up — if the tutorial created billable/persistent resources;
    if nothing needs removing, say so in one line rather than omitting. */}

{/* ## What you built — 3–5 bullets mapping what they did to what they now
    know; the recap belongs here, because the reader was learning, not
    looking up. */}

{/* ## Next steps — 2–4 links: the concept behind the magic parts, the
    how-tos for productionizing, the next tutorial if one exists. */}
```

## 5. Structure & components

- **Numbered parts with expected-output blocks** are the spine — the verbatim "You should see" output after every part is the confidence machine; never skip one.
- **Error-recovery as plain prose** at the points readers actually stumble is happy-path content here — not exception callouts, because in a tutorial anticipated errors aren't exceptions. Anticipating the three likely mistakes teaches more than pretending they can't happen.
- **Doesn't fit:** tabs and options of any kind (the author chose; per-stack means per-page), long conceptual asides (link out), anything that hides steps.
- **Ending, in order:** Clean up (one line even when there's nothing to remove) → What you built (the recap — the reader was acquiring skill, so naming what they now know is part of the teaching) → Next steps.
- **Thresholds:** ≤ ~7 parts; 15–60 minutes stated honestly up front with a concrete difficulty proxy; explanation ≤ 2 sentences then a link; zero decisions, zero alternatives, zero unexplained magic. It works *every time* — staged failures don't break that contract, because the teacher injects them and guarantees the recovery. Pin every version in Before you begin.

## 6. Write the page

Create `src/content/docs/<section>/<slug>.mdx` following the skeleton, adapted to the user's product and the site's registered components. Show the destination before part 1. Each part must be self-contained — full-context heading, the full command, and the verbatim result — so a reader or agent landing mid-tutorial knows where they are. Keep every expected output in a fenced block with full, realistic values, and pin every version named in Before you begin.

## 7. Verify

- Run the build, matching the user's package manager (`pnpm build`, `npm run build`, …); confirm it completes clean.
- If the site has lint configured, run `pnpm exec nimbus-docs lint`.
- Re-run the tutorial end-to-end on a cold environment and stamp `lastVerified`.
- Self-review against the checklist below.

## Checklist

- [ ] Title is "Build \<outcome\>"; destination shown before part 1
- [ ] Learning objectives (3–5), time estimate, and a concrete difficulty proxy up front
- [ ] Versions pinned in Before you begin; mocked pieces named
- [ ] Every part ends with a visible, verbatim result; headings self-contained
- [ ] Error-recovery prose at the likely stumbles; nothing blames the reader
- [ ] Zero options or alternatives; explanation ≤ 2 sentences then a link
- [ ] ≤ ~7 parts; honest 15–60 minute scope
- [ ] Ends Clean up (one line minimum) → What you built → Next steps
- [ ] Re-run end-to-end on a cold environment this release; `lastVerified` stamped

## Already have one?

If the target page already exists, do not overwrite it without confirming. Offer to review it against this recipe and suggest specific edits instead.
