---
{
  "name": "content-example",
  "type": "registry:feature",
  "title": "Recipe: Example",
  "description": "Scaffold a cookbook page — complete, runnable code the reader copies whole, with prose only for the non-obvious."
}
---

# Recipe: Example

You are helping the user write an **example** page for their Nimbus docs site — a cookbook page where the code *is* the content, a pattern or integration worth copying whole ("Show me working code for X."). Read this entire file before writing.

The full, browsable version of this recipe, with the complete rationale, lives at <https://nimbus-docs.com/writing/recipes/example> — and its agent-readable twin at <https://nimbus-docs.com/writing/recipes/example/index.md>. Fetch it if you need more depth than this handoff carries.

## 1. Discovery

Inspect the repo before writing — do not assume:

- `package.json` — confirm this is a Nimbus project (depends on `nimbus-docs`).
- `src/components.ts` — the registered MDX components. Examples lean on `Code` with a `title` meta (the filename is load-bearing), `CodeGroup` for a multi-file example, and `Aside`/`Callout` for the rare one-line warning. Use only registered components; install a missing one with `nimbus-docs add <slug>` and register it.
- `src/content.config.ts` — the docs collection's frontmatter schema, so you only emit fields the site accepts.
- `src/content/docs/` — where the page belongs; match sibling folder and sidebar-order conventions.
- Ask the user for the real specifics (runtime, package versions, env vars, exact output). Never invent product behavior.

## 2. When to use it

Write an example when **the code is the content** — a pattern, integration, or configuration worth copying whole. It is **not** a how-to (a *procedure* across surfaces, verified at the end — here the reader's only action is copy and adapt), **not** reference (complete and neutral; examples are selective and goal-indexed), and **not** a tutorial (no narrative, no teaching). Two laws: **complete and runnable** (full imports, full config, zero elisions — a fragment "you'll need to adapt" is homework, not an example) and **tested** (code that doesn't run fails in the reader's editor with the product's name on it; run it in CI if you can, stamp `lastVerified` either way).

## 3. Title & description

- **Title: the goal plus the stack.** "Verify signatures **in a Next.js route handler**," "Debounce webhook bursts **with Redis**." The stack qualifier is the type's title signal — the code is the content, so name the environment it lives in. Cookbook pages take a noun-phrase category title ("Signature verification"). Never "Example 3" or "Miscellaneous snippets."
- **Description formula:** *What the code does, in the stack it's written for* — e.g. "Verify Hookline signatures in a Next.js route handler, rejecting replays."

## 4. Skeleton

```mdx
---
title: Verify signatures in a Next.js route handler
description: Verify Hookline signatures in a Next.js route handler, rejecting replays.
type: example
lastVerified: 2026-07-06
---

{/* Goal: 1–2 sentences — what this code does and when you'd want it.
    Then get to the code. */}

{/* Assumptions: one line — runtime, versions, what must already exist
    ("Next.js 15, @hookline/sdk 3.2, HOOKLINE_SECRET set"). Checkable
    facts; anything longer than a line links to the how-to that sets
    it up. */}

{/* THE CODE — the body of the page. One complete listing (or a small
    file set as titled code blocks / a code group). Full imports, real
    structure, realistic values, zero elisions. If it doesn't run as
    pasted, it isn't done. */}

{/* Shown result — what the pasted code produces: the response, log line,
    or header, in a fenced block, ideally with the command that elicits
    it. This is Law 1's other half — "runnable" is only checkable against
    a shown result. */}

{/* ## How it works — bullets on ONLY the non-obvious lines ("tolerance
    is 300s because…"). If a line needs a paragraph, it needs a concept
    link instead. Skip the section when the code is self-evident. */}

{/* Variations: one-liners or links — "for Express, see …". Never a
    second full listing bolted on; a variation that needs its own
    listing is its own example. */}

{/* ## See also — the concept behind it, the reference for the values,
    the how-to for the setup. */}
```

## 5. Structure & components

- **Titled code blocks** are the signature component — `Code` with a `title` meta (`title="app/api/hooks/route.ts"`) makes the filename load-bearing context. Reach for `CodeGroup` when a multi-file example is honest; one file is better when it can be.
- **Comments inside the code** carry point-of-use notes (`// rejects deliveries signed >5 min ago`) — the one place code comments beat prose, because they survive the copy-paste.
- **Doesn't fit:** steps (nothing is performed), cards or accordions (hidden code is unfindable and unextractable), language tabs *unless every tab is maintained and tested* — an untested tab is a broken example hiding behind a tested one.
- **Cookbook form:** related examples can share one page under a noun-phrase category; each `##` entry follows the skeleton minus frontmatter, most-wanted first, same internal template. Split an entry to its own page when its code outgrows a screen. One `lastVerified` means the page's *oldest-verified* entry.
- **Ending, in order:** shown result → How it works (when needed) → See also. No Verify section, no next-steps journey — the reader came for the code and is leaving with it.
- **Thresholds:** one goal per example (needs "and" → split); explanation must not outgrow the code (paragraphs in How-it-works mean a concept or how-to is trying to get out — link it); handle the errors the pattern is about and let the rest throw.

## 6. Write the page

Create `src/content/docs/<section>/<slug>.mdx` following the skeleton, adapted to the user's stack and the site's registered components. The listing must run as pasted: full imports, real structure, realistic values, zero elisions — an elided import becomes a hallucinated one in someone's codebase. State assumptions as checkable facts (versions, env vars) on the page. Follow the code with a shown result in a fenced block, ideally with the command that elicits it. Placeholders only in `<angle-brackets>`, and only where a real value can't exist.

## 7. Verify

- Run the build, matching the user's package manager (`pnpm build`, `npm run build`, …); confirm it completes clean.
- If the site has lint configured, run `pnpm exec nimbus-docs lint`.
- Actually run the example code against the current release (CI if possible) and stamp `lastVerified` — an example that no longer compiles is the loudest signal a product is unmaintained.
- Self-review against the checklist below.

## Checklist

- [ ] Title is the goal plus the stack (cookbook page: noun-phrase category); one goal
- [ ] Assumptions stated in one line as checkable facts (versions, env)
- [ ] Code complete and runnable as pasted — full imports, zero elisions, type-checks under strict settings
- [ ] Shown result present: the output the pasted code produces, and how to elicit it
- [ ] Realistic values; placeholders only in `<angle-brackets>`
- [ ] How-it-works covers only the non-obvious lines; provider-specific assumptions flagged
- [ ] Error handling scoped to what the pattern is about
- [ ] Variations are links, not bolted-on listings; cookbook entries share one internal template
- [ ] Tested against the current release (CI if possible); `lastVerified` stamped (cookbook: oldest entry)

## Already have one?

If the target page already exists, do not overwrite it without confirming. Offer to review it against this recipe and suggest specific edits instead.
