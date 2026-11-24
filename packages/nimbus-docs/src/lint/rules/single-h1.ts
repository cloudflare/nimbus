/**
 * nimbus/single-h1 — a page should have at most one top-level (`#`)
 * heading. Reports every H1 after the first. Zero H1s is fine: many
 * layouts render the page title from frontmatter, so the body legitimately
 * starts at H2.
 *
 * Detection is the `multipleTopLevelHeadings` detector (`../detectors.ts`),
 * which also counts HTML and MDX `<h1>`. The message stays Nimbus-shaped so
 * the agent-loop hint ("demote to ##") is preserved.
 */

import { multipleTopLevelHeadings } from "../detectors.js";
import type { Rule } from "../rule.js";

export const singleH1: Rule = {
  code: "nimbus/single-h1",
  run(ctx) {
    const reports = multipleTopLevelHeadings(ctx.file.tree);
    for (const r of reports) {
      ctx.report({
        ...r,
        message:
          'more than one top-level "#" heading — a page should have a single H1. Demote this to "##" or fold it into the page above.',
      });
    }
  },
};
