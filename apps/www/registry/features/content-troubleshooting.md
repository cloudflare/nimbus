---
{
  "name": "content-troubleshooting",
  "type": "registry:feature",
  "title": "Recipe: Troubleshooting",
  "description": "Scaffold a failure page — verbatim symptoms, causes, and fixes, titled by what the reader pastes into search."
}
---

# Recipe: Troubleshooting

You are helping the user write a **troubleshooting** page for their Nimbus docs site — a failure page whose reader has an error string or a symptom and will paste it into search ("Why am I seeing this, and how do I make it stop?"). Errors are content, not exceptions. Read this entire file before writing.

The full, browsable version of this recipe, with the complete rationale, lives at <https://nimbus-docs.com/writing/recipes/troubleshooting> — and its agent-readable twin at <https://nimbus-docs.com/writing/recipes/troubleshooting/index.md>. Fetch it if you need more depth than this handoff carries.

## 1. Discovery

Inspect the repo before writing — do not assume:

- `package.json` — confirm this is a Nimbus project (depends on `nimbus-docs`).
- `src/components.ts` — the registered MDX components. Troubleshooting leans on `Accordion` for FAQ-style inline entries, `Aside`/`Callout` for "What if…" warnings, and `Code` for the verbatim message. Use only registered components; install a missing one with `nimbus-docs add <slug>` and register it.
- `src/content.config.ts` — the docs collection's frontmatter schema, so you only emit fields the site accepts.
- `src/content/docs/` — where the page belongs; match sibling folder and sidebar-order conventions.
- Ask the user for the real specifics (exact error strings, log lines, confirmation commands, expected output). Never invent product behavior — and never paraphrase an error.

## 2. When to use it

Troubleshooting lives in two places, both covered here:

- **Inline, on the page where the failure happens** — the default. A "What if…" callout inside a how-to, or an `Accordion` at a feature page's end. Same internal shape, compressed:

  > **What if login fails with `Error: no workspace selected`?**
  > The CLI is authenticated but not pointed at a workspace. Run `hookline workspace use <name>` and retry.

- **A dedicated troubleshooting page per product area** — once inline entries pass ~5, or the same failure spans multiple pages.

It is **not** a how-to (which pursues a goal; troubleshooting recovers from a failure), **not** an error reference (a complete per-code catalog is reference material — this page covers symptoms, multi-cause problems, and the "it's slow / it's flaky" cases codes don't capture), and **not** a global FAQ. A troubleshooting page is organized by *failure*, not by *question*.

## 3. Title & description

- **Entry titles: the verbatim symptom — ideally the exact error message.** "Error: signature timestamp outside tolerance" beats "Signature problems" in search, in retrieval, and in a sidebar scan. Trim long messages to the distinctive substring (~70 chars) with ASCII `...` marking the cut; keep the message type ("Error:", "Warning:"). Symptom-shaped entries without a message get observable phrasing: "Deliveries succeed but arrive twice."
- **Page title:** "Troubleshooting *area*" — e.g. "Troubleshooting delivery."
- **Description formula:** *Fixes for the common failures in area, by symptom.*

## 4. Skeleton

```mdx
---
title: Troubleshooting delivery
description: Fixes for the common failures in Hookline delivery, by symptom.
type: troubleshooting
lastVerified: 2026-07-06
---

{/* Orientation: 1–2 lines — what area this page covers, link to the error
    catalog if one exists, and where to escalate if nothing here matches. */}

{/* ## <Verbatim error message or observable symptom> — one section per
    failure. Order: most common first; a data-loss failure jumps the queue.
    Fixed internal order:

    1. Symptom — what the reader sees: the exact message in a fenced block
       as ONE realistic concrete instance (variable values and all — the
       stable substring still matches), the log line, the behavior.
    2. Cause — why it happens. One or two sentences for a single cause;
       multiple causes get a bullet each, most likely first, each bullet
       naming how to confirm it's the one ("if X, this is your cause").
    3. Fix — numbered steps if it's a sequence, one line if it's one act;
       one fix per cause when causes are multiple. Distinguish RESOLUTION
       (permanent) from WORKAROUND (temporary, with its cost stated).
    4. Verify (when non-obvious) — how to confirm it's actually fixed. */}

{/* ## Still stuck? — the escalation path: what to collect (IDs, log
    excerpts), where to send it. Required on dedicated pages. */}
```

## 5. Structure & components

- **Fenced blocks carry the verbatim message** — the match target for search, readers, and retrieval. Show one realistic concrete instance, variable values included (`skew 512s > 300s` demonstrates the mechanic; the stable substring still matches). Never paraphrase the error; never elide its distinctive part.
- **Bold Cause / Fix / Verify labels** (or a fixed sub-heading trio) — the uniform internal order lets a panicking reader skip straight to Fix.
- **Accordions** fit the inline form (FAQ-style at a feature page's end); on dedicated pages entries stay open — hidden symptoms are unfindable, and the page exists to be scanned. Doesn't fit: Cards, marketing tone, reassurance without a fix.
- **Ending:** dedicated pages close with **Still stuck?** — the escalation path with a collect-this-first list. It's the type's honesty clause: a page that implies completeness strands the reader with the one failure it missed.
- **Thresholds:** inline until ~5 entries, then a dedicated page (leave a link behind at the inline site); most common failure first, data-loss failures jump the queue; every workaround states its cost and its permanent alternative.

## 6. Write the page

Create `src/content/docs/<section>/<slug>.mdx` following the skeleton, adapted to the user's product and the site's registered components. Keep each entry fully self-contained — entry N will be retrieved without entry N−1 and without the page intro. Structure Cause → Fix as declaratives an agent can execute: "check your configuration" is not a fix, `hookline test-event --endpoint <id>` is. Link every Cause to the concept explaining the mechanism, and every multi-step Fix to (or make it) a how-to.

## 7. Verify

- Run the build, matching the user's package manager (`pnpm build`, `npm run build`, …); confirm it completes clean.
- If the site has lint configured, run `pnpm exec nimbus-docs lint`.
- Self-review against the checklist below.

## Checklist

- [ ] Entry titles are verbatim messages or observable symptoms (long ones trimmed to the distinctive substring, ~70 chars)
- [ ] Every entry with a message shows it in a fenced block, as one concrete instance; symptom-only entries state the observable behavior in their first line
- [ ] Fixed internal order: Symptom → Cause → Fix (→ Verify); multi-cause entries pair each cause with its confirmation and its fix
- [ ] Workarounds labeled, costed, and paired with the permanent fix
- [ ] Most common failure first; data-loss failures jump the queue
- [ ] Dedicated page ends with Still stuck? + collect-this-first list
- [ ] Causes link to concepts; multi-step fixes link to how-tos
- [ ] Entries pruned when the underlying failure is fixed; `lastVerified` stamped on sweep

## Already have one?

If the target page already exists, do not overwrite it without confirming. Offer to review it against this recipe and suggest specific edits instead.
