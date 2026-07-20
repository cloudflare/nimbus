---
{
  "name": "content-how-to",
  "type": "registry:feature",
  "title": "Recipe: How-to guide",
  "description": "Scaffold a task page — numbered steps that take a competent reader from a goal to a verified outcome."
}
---

# Recipe: How-to guide

You are helping the user write a **how-to guide** for their Nimbus docs site — a task page whose reader already knows what they want and needs the steps, not the theory ("How do I do X?"). Read this entire file before writing.

The full, browsable version of this recipe, with the complete rationale, lives at <https://nimbus-docs.com/writing/recipes/how-to> — and its agent-readable twin at <https://nimbus-docs.com/writing/recipes/how-to/index.md>. Fetch it if you need more depth than this handoff carries.

## 1. Discovery

Inspect the repo before writing — do not assume:

- `package.json` — confirm this is a Nimbus project (depends on `nimbus-docs`).
- `src/components.ts` — the registered MDX components. How-tos lean on `Steps`/`Step` (or a plain ordered list), `Tabs`/`TabItem` for variant axes, `Aside`/`Callout` for warnings, and `Code`. Use only registered components; install a missing one with `nimbus-docs add <slug>` and register it.
- `src/content.config.ts` — the docs collection's frontmatter schema, so you only emit fields the site accepts.
- `src/content/docs/` — where the page belongs; match sibling folder and sidebar-order conventions.
- Ask the user for the real specifics (commands, UI labels, endpoints, expected output). Never invent product behavior.

## 2. When to use it

One goal, one outcome, a reader competent enough to follow directions. It is **not** a tutorial (which teaches by building and must never fail), **not** reference (looking up a value), and **not** a concept (explaining *why*). One goal per page — if the title needs "and," it's two pages.

## 3. Title & description

- **Title:** imperative verb phrase stating the goal — "Rotate a signing secret," "Add a second endpoint." No gerunds, no bare nouns, no "How to" prefix.
- **Description formula:** *Verb the thing, with the benefit or key constraint.*

## 4. Skeleton

```mdx
---
title: Rotate a signing secret
description: Rotate a signing secret without dropping deliveries. Both secrets stay valid during the overlap window.
type: how-to
lastVerified: 2026-07-06
---

{/* Context: 1–2 sentences max. When/why you'd do this — not what the product is. */}

{/* ## Prerequisites — bullet list: access/roles, things created, decisions made.
    Quarantine third-party setup here. Skip the section if there are truly none. */}

{/* ## Steps — the happy path only, verb-first, one action per step.
    - Steps component or a plain ordered list (both must read identically in the .md twin).
    - State location before action ("In Settings → Webhooks, select…").
    - Show the expected result after any non-obvious step.
    - A warning callout BEFORE a destructive/irreversible step is part of the happy path.
    - Long single-goal procedures group into ### phases; the step budget applies per phase.
    - Variant axis (reader's environment decides) → tabs/code groups on one page.
      Alternative methods (you decide) → document the recommended one, link the rest. */}

{/* ## Verify — how the reader confirms it worked, BEFORE any step that makes failure
    expensive. A command to run, output to expect, or a screen to check — with the
    failure branch ("If you see X, do Y"). */}

{/* ## <Irreversible closing step> — only if the task ends in one; runs after Verify passes. */}

{/* ## Optional: <thing> — zero or more blocks after the happy path. */}

{/* ## Next steps — 2–4 curated links: the next task, the concept behind it, the reference. */}
```

## 5. Structure & components

- **Numbered steps** are the signature structure — `Steps` or a plain ordered list; both must read identically in the `.md` twin. No steps? Question whether it's a how-to.
- **Tabs / code groups** carry variant axes (language, platform, CLI-vs-dashboard) *inside* one canonical page. For alternative *methods*, pick the recommended one and link the rest — never duplicate the page.
- **Callouts** warn before destructive steps; a page drowning in exception callouts has the wrong happy path.
- **Ending, in order:** Verify → the irreversible closing step (if any) → optional blocks → Next steps. Never end on the last numbered step.
- **Thresholds:** ≤ ~10 steps per phase; context intro ≤ 2 sentences; one goal.

## 6. Write the page

Create `src/content/docs/<section>/<slug>.mdx` following the skeleton, adapted to the user's product and the site's registered components. Each step must be executable without the surrounding page: name the product area, the full command, the exact setting label — never "as configured above." Keep expected outputs in fenced blocks with full, realistic values.

## 7. Verify

- Run the build, matching the user's package manager (`pnpm build`, `npm run build`, …); confirm it completes clean.
- If the site has lint configured, run `nimbus-docs lint`.
- Self-review against the checklist below.

## Checklist

- [ ] Title is an imperative verb phrase; one goal, no umbrella verbs
- [ ] Prerequisites complete — a reader who meets them finishes without leaving the page
- [ ] Every step: verb-first, one action, location before action
- [ ] Happy path unbroken — variant axes in tabs/pickers, alternative methods picked-and-linked, options quarantined after Verify
- [ ] Warnings precede destructive steps; Verify precedes expensive-to-undo steps
- [ ] Verify exists — runnable with a failure branch, or one self-evident sentence
- [ ] Irreversible closing steps (delete, cutover, end-overlap) come after Verify, in their own section
- [ ] Ends with Next steps (2–4 links), not a final step
- [ ] ≤ ~10 steps per phase; context ≤ 2 sentences
- [ ] No positional references ("as mentioned above"); every section self-contained

## Already have one?

If the target page already exists, do not overwrite it without confirming. Offer to review it against this recipe and suggest specific edits instead.
