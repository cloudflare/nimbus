/**
 * nimbus/heading-hierarchy — headings shouldn't skip levels. Going from an
 * H2 straight to an H4 breaks the document outline (and screen-reader
 * navigation). Reports the heading that does the skipping.
 *
 * Detection is delegated to `remark-lint-heading-increment` via the
 * adapter. The wrapper re-walks the tree at each reported position to
 * find the offending heading and its predecessor, then constructs a
 * dynamic message ("h2 to h4 — use h3 instead").
 */

import remarkLintHeadingIncrement from "remark-lint-heading-increment";

import { collect } from "../parse.js";
import { runRemarkLintRule } from "../remark-lint-adapter.js";
import type { Rule } from "../rule.js";

export const headingHierarchy: Rule = {
  code: "nimbus/heading-hierarchy",
  run(ctx) {
    const reports = runRemarkLintRule(
      remarkLintHeadingIncrement,
      ctx.file.tree,
      { path: ctx.file.path, source: ctx.file.source },
    );

    if (reports.length === 0) return;

    const headings = collect(ctx.file.tree, "heading");

    for (const r of reports) {
      const idx = headings.findIndex((h) => {
        const p = h.position?.start;
        return p?.line === r.line && p?.column === r.column;
      });

      if (idx <= 0) {
        // Defensive: no predecessor (or position drifted) — fall back to
        // a static message rather than misreport the levels.
        ctx.report({
          ...r,
          message:
            "heading level skips — don't jump past a level. Insert the missing depth instead.",
        });
        continue;
      }

      const prevDepth = headings[idx - 1]!.depth ?? 1;
      const curDepth = headings[idx]!.depth ?? 1;
      ctx.report({
        ...r,
        message: `heading level jumps from h${prevDepth} to h${curDepth} — don't skip levels; use h${prevDepth + 1} instead.`,
      });
    }
  },
};
