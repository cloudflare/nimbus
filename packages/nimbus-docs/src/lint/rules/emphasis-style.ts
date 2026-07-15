/**
 * nimbus/emphasis-style — consistent italic delimiter. `style?:
 * "asterisk" | "underscore"` (default `asterisk`). Auto-fixable: swap both
 * delimiters. Targets italic (`emphasis`); bold (`strong`) is left alone.
 *
 * Detection is delegated to `remark-lint-emphasis-marker` via the
 * adapter (configured with the chosen marker). The wrapper re-walks the
 * tree at each reported position to recover both delimiter offsets for
 * the two-edit surgical fix.
 */

import remarkLintEmphasisMarker from "remark-lint-emphasis-marker";

import { findNodeAt } from "../parse.js";
import { runRemarkLintRule } from "../remark-lint-adapter.js";
import type { Rule } from "../rule.js";

const DELIM = { asterisk: "*", underscore: "_" } as const;

export const emphasisStyle: Rule = {
  code: "nimbus/emphasis-style",
  run(ctx) {
    const style = ctx.options.style === "underscore" ? "underscore" : "asterisk";
    const want = DELIM[style];

    const reports = runRemarkLintRule(
      remarkLintEmphasisMarker,
      ctx.file.tree,
      {
        path: ctx.file.path,
        source: ctx.file.source,
        settings: [want],
      },
    );

    for (const r of reports) {
      const node = findNodeAt(ctx.file.tree, "emphasis", r.line, r.column);
      const start = node?.position?.start.offset;
      const end = node?.position?.end.offset;
      if (typeof start !== "number" || typeof end !== "number") {
        ctx.report({
          ...r,
          message: `italic delimiter should be "${want}".`,
        });
        continue;
      }
      const open = ctx.file.source[start];
      if (open !== "_" && open !== "*") {
        ctx.report({
          ...r,
          message: `italic delimiter should be "${want}".`,
        });
        continue;
      }

      ctx.report({
        ...r,
        message: `italic uses "${open}…${open}" — this project's emphasis marker is "${want}".`,
        fix: {
          description: `change the "${open}" delimiters to "${want}"`,
          edits: [
            { range: [start, start + 1], text: want },
            { range: [end - 1, end], text: want },
          ],
        },
      });
    }
  },
};
