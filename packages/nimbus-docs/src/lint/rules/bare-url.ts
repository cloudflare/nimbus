/**
 * nimbus/bare-url — a naked external URL in prose reads worse than a
 * descriptive link and is easy to mis-click. Flags `<https://…>`-style
 * autolinks and bare `text === url` links. Not auto-fixed: good link text
 * needs judgment.
 *
 * Detection is delegated to `remark-lint-no-literal-urls` via the
 * adapter.
 */

import remarkLintNoLiteralUrls from "remark-lint-no-literal-urls";

import { runRemarkLintRule } from "../remark-lint-adapter.js";
import type { Rule } from "../rule.js";

export const bareUrl: Rule = {
  code: "nimbus/bare-url",
  run(ctx) {
    const reports = runRemarkLintRule(
      remarkLintNoLiteralUrls,
      ctx.file.tree,
      { path: ctx.file.path, source: ctx.file.source },
    );
    for (const r of reports) {
      ctx.report({
        ...r,
        message:
          "bare URL in prose — wrap it in descriptive link text: [what it is](url).",
      });
    }
  },
};
