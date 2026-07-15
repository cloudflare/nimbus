/**
 * nimbus/code-block-lang — every fenced code block should declare a
 * language, so syntax highlighting, the copy button, and the language
 * badge all work.
 *
 * Detection is delegated to `remark-lint-fenced-code-flag` via the
 * adapter. `allow?: string[]` is accepted (and round-trips through
 * config) as the forward-compatible hook for validating against a
 * known-language set; today the rule only flags the missing-language
 * case, so any declared language passes.
 */

import remarkLintFencedCodeFlag from "remark-lint-fenced-code-flag";

import { runRemarkLintRule } from "../remark-lint-adapter.js";
import type { Rule } from "../rule.js";

export const codeBlockLang: Rule = {
  code: "nimbus/code-block-lang",
  run(ctx) {
    const reports = runRemarkLintRule(
      remarkLintFencedCodeFlag,
      ctx.file.tree,
      { path: ctx.file.path, source: ctx.file.source },
    );
    for (const r of reports) {
      ctx.report({
        ...r,
        message:
          'fenced code block has no language — add one (e.g. ```ts) so highlighting, the copy button, and the language badge render.',
      });
    }
  },
};
