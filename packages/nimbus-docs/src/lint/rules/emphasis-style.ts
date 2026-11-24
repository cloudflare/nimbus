/**
 * nimbus/emphasis-style — consistent italic delimiter. `style?:
 * "asterisk" | "underscore"` (default `asterisk`). Auto-fixable: swap both
 * delimiters. Targets italic (`emphasis`); bold (`strong`) is left alone.
 *
 * Detection is the `emphasisMarker` detector (`../detectors.ts`), given
 * the chosen marker. The wrapper re-walks the
 * tree at each reported position to recover both delimiter offsets for
 * the two-edit surgical fix.
 */

import { findNodeAt } from "../parse.js";
import { emphasisMarker } from "../detectors.js";
import type { Rule } from "../rule.js";

const DELIM = { asterisk: "*", underscore: "_" } as const;

export const emphasisStyle: Rule = {
  code: "nimbus/emphasis-style",
  run(ctx) {
    const style = ctx.options.style === "underscore" ? "underscore" : "asterisk";
    const want = DELIM[style];

    const reports = emphasisMarker(ctx.file.tree, ctx.file.source, want);

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
