/**
 * nimbus/duplicate-heading-text — two headings with the same text generate
 * colliding anchor slugs, so deep links land on the wrong one. Reports the
 * second (and later) occurrence. Not auto-fixable — renaming needs
 * judgment.
 *
 * Detection is delegated to `remark-lint-no-duplicate-headings` via the
 * adapter. The wrapper re-walks the tree at each reported position to
 * recover the duplicate heading's text (and the first occurrence's line)
 * for the message — the dynamic info matters for navigability.
 */

import remarkLintNoDuplicateHeadings from "remark-lint-no-duplicate-headings";

import { collect, findNodeAt, startOf, textOf } from "../parse.js";
import { runRemarkLintRule } from "../remark-lint-adapter.js";
import type { Rule } from "../rule.js";

export const duplicateHeadingText: Rule = {
  code: "nimbus/duplicate-heading-text",
  run(ctx) {
    const reports = runRemarkLintRule(
      remarkLintNoDuplicateHeadings,
      ctx.file.tree,
      { path: ctx.file.path, source: ctx.file.source },
    );

    if (reports.length === 0) return;

    // Build a map of normalized heading text → first occurrence line so
    // we can reproduce the "(first used on line N)" hint the
    // hand-rolled rule emitted.
    const firstSeen = new Map<string, number>();
    for (const heading of collect(ctx.file.tree, "heading")) {
      const key = textOf(heading).trim().toLowerCase();
      if (key === "") continue;
      if (!firstSeen.has(key)) firstSeen.set(key, startOf(heading).line);
    }

    for (const r of reports) {
      const heading = findNodeAt(ctx.file.tree, "heading", r.line, r.column);
      if (!heading) {
        ctx.report({
          ...r,
          message:
            "duplicate heading text — duplicate headings produce colliding anchor links.",
        });
        continue;
      }
      const text = textOf(heading).trim();
      const first = firstSeen.get(text.toLowerCase());
      ctx.report({
        ...r,
        message:
          first !== undefined && first !== r.line
            ? `duplicate heading "${text}" (first used on line ${first}) — duplicate headings produce colliding anchor links.`
            : `duplicate heading "${text}" — duplicate headings produce colliding anchor links.`,
      });
    }
  },
};
