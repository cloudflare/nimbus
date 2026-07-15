/**
 * nimbus/single-h1 — a page should have at most one top-level (`#`)
 * heading. Reports every H1 after the first. Zero H1s is fine: many
 * layouts render the page title from frontmatter, so the body legitimately
 * starts at H2.
 *
 * Detection is delegated to `remark-lint-no-multiple-toplevel-headings`
 * via the remark-lint adapter — Sätteri-parsed tree, remark-lint detector
 * logic, our message + envelope. The message stays Nimbus-shaped so the
 * agent-loop hint ("demote to ##") is preserved.
 */

import remarkLintNoMultipleTopLevelHeadings from "remark-lint-no-multiple-toplevel-headings";

import { runRemarkLintRule } from "../remark-lint-adapter.js";
import type { Rule } from "../rule.js";

export const singleH1: Rule = {
  code: "nimbus/single-h1",
  run(ctx) {
    const reports = runRemarkLintRule(
      remarkLintNoMultipleTopLevelHeadings,
      ctx.file.tree,
      { path: ctx.file.path, source: ctx.file.source },
    );
    for (const r of reports) {
      ctx.report({
        ...r,
        message:
          'more than one top-level "#" heading — a page should have a single H1. Demote this to "##" or fold it into the page above.',
      });
    }
  },
};
