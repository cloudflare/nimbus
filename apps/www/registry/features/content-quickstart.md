---
{
  "name": "content-quickstart",
  "type": "registry:feature",
  "title": "Recipe: Quickstart",
  "description": "Scaffold a first-success page — the shortest honest path from nothing to one working result, with the output shown."
}
---

# Recipe: Quickstart

You are helping the user write a **quickstart** for their Nimbus docs site — a first-success page whose reader is evaluating or just signed up and wants proof the product works: one real result, fast ("How quickly can I see this do something?"). The metric is time-to-first-success, and it's priced — longer quickstarts measurably lose readers. Read this entire file before writing.

The full, browsable version of this recipe, with the complete rationale, lives at <https://nimbus-docs.com/writing/recipes/quickstart> — and its agent-readable twin at <https://nimbus-docs.com/writing/recipes/quickstart/index.md>. Fetch it if you need more depth than this handoff carries.

## 1. Discovery

Inspect the repo before writing — do not assume:

- `package.json` — confirm this is a Nimbus project (depends on `nimbus-docs`).
- `src/components.ts` — the registered MDX components. Quickstarts lean on `Steps`/`Step`, `Code` (fenced blocks with visible output), `PackageManagers` for install commands, and `Aside`/`Callout` sparingly. Use only registered components; install a missing one with `nimbus-docs add <slug>` and register it.
- `src/content.config.ts` — the docs collection's frontmatter schema, so you only emit fields the site accepts.
- `src/content/docs/` — where the page belongs; match sibling folder and sidebar-order conventions.
- Ask the user for the real specifics (commands, keys, expected output). Never invent product behavior — an agent will run this page verbatim.

## 2. When to use it

Exactly one quickstart per major path (one for the API, one for the dashboard). It is **not** a tutorial (no learning objectives, no explanations beyond one "what just happened" line — the reader is testing, not studying) and **not** a how-to (which serves a reader mid-work with their own goal; the quickstart's only goal is *first* success, and it chooses the goal for the reader).

The defining constraint: **the author makes every choice for the reader.** One language (with tabs for the rest), one install method, defaults everywhere. When a choice genuinely can't be defaulted away (region, org type), make the recommended choice and note the alternative in one trailing line — never a fork mid-steps.

**The get-started variant.** Some products can't reach an honest first success without real configuration (DNS, tenant setup). For those, write this same recipe as a **"Get started"** page: title is the fixed string "Get started," the budget relaxes to the *minimum viable configuration* of the most general use case, and Prerequisites may include real decisions — each collapsed to a recommended default with one line on when to choose otherwise. Everything else applies unchanged. Products with a fast path ship both.

## 3. Title & description

- **Title:** "Quickstart" when there's one; "Quickstart: *path or stack*" when stamped per framework or entry path ("Quickstart: Next.js," "Quickstart: Dashboard"). The get-started variant is titled "Get started," always.
- **Description formula:** *Outcome* in *time bound* — e.g. "Send your first webhook in five minutes." Only promise a time you've watched a stranger hit.

## 4. Skeleton

```mdx
---
title: Quickstart
description: Send your first webhook in five minutes.
type: quickstart
lastVerified: 2026-07-06
---

{/* Opening: one sentence — what the reader will have at the end, and the time
    bound. No product pitch; the overview page did that. */}

{/* ## Prerequisites — the shortest honest list: account, runtime, key.
    Checkable facts ("Node 20+"), not vibes. If a prerequisite takes more
    than a minute, link it, don't inline it. */}

{/* ## Steps — 3–6 numbered steps: install → authenticate → do the one thing.
    Defaults chosen for the reader; variant tabs only for language/stack.
    Show a step's output inline only where silence would look like failure
    (login confirmations, long-running starts); the payoff output lives in
    "You should see." */}

{/* ## You should see — fixed heading, the contract of the page: the expected
    output in a fenced block, one realistic concrete instance, with
    run-varying fields (timings, IDs) shown as placeholders (<n>ms).
    Immediately after: 1–2 sentences of "what just happened" — the only
    explanation allowed on the page. */}

{/* ## Next step — fixed heading: exactly one primary link (the path most
    readers take next), plus at most two secondary links. A quickstart that
    ends in a link farm undoes its own focus. */}
```

"You should see" and "Next step" are contractual literal headings — readers (and agents) learn to jump to them.

## 5. Structure & components

- **Steps** and **fenced code with visible output** are the whole page. The "You should see" block is the single most important element — it's the proof.
- **Tabs / `PackageManagers`** carry only the language/stack axis, and only when the samples are truly parallel. Any other choice: the author decides.
- **Doesn't fit:** cards, accordions, callouts about edge cases, links mid-step. Anything not on the shortest path is on the wrong page.
- **Ending, in order:** You should see (expected output + one "what just happened" line) → Next step with exactly one primary link. Route to the thing that deepens adoption, not a generic docs home.
- **Thresholds:** ≤ ~600 words per rendered path, ≤ 6 steps, one feature; no error handling, no options, no production hardening. When the natural integration blows the budget, shrink the first success (a hosted page, a CLI-triggered loop, a single call) rather than padding — the full integration belongs in a get-started page or how-to. The steps must work every single time.

## 6. Write the page

Create `src/content/docs/<section>/<slug>.mdx` following the skeleton, adapted to the user's product and the site's registered components. Every command must be copy-runnable: placeholders in `<angle-brackets>` (`hl_test_<your-key>`), never a bare ellipsis inside a command. Mark run-varying output fields (timings, generated IDs) as placeholders (`<n>ms`) so an agent diffing its output against yours doesn't read normal variance as failure — everything else in the output block stays verbatim. Model test-mode credentials. In the `.md` twin, language tabs flatten into labeled sequential blocks, so the expected output must appear once per path, never only in the default tab.

## 7. Verify

- Run the quickstart end-to-end against a cold start, matching the user's package manager (`pnpm build`, `npm run build`, …); this page rots fastest of all types, so re-run it on every release that touches its path and stamp `lastVerified`.
- If the site has lint configured, run `nimbus-docs lint`.
- Self-review against the checklist below.

## Checklist

- [ ] Time bound in the description, tested against a cold start
- [ ] Reader makes zero decisions (tabs for language/stack only; undefaultable choices made for them with a one-line alternative)
- [ ] ≤ ~600 words per rendered path, ≤ 6 steps, one feature — or the first success was shrunk until it fits
- [ ] Test-mode credentials modeled; placeholders in angle brackets, no ellipses in commands
- [ ] "You should see" heading present; output verbatim except placeheld run-varying fields
- [ ] "What just happened" ≤ 2 sentences
- [ ] Ends with exactly one primary next step
- [ ] Verified end-to-end on the current release; `lastVerified` stamped

## Already have one?

If the target page already exists, do not overwrite it without confirming. Offer to review it against this recipe and suggest specific edits instead.
