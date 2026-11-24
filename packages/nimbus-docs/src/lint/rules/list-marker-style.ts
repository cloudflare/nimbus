/**
 * nimbus/list-marker-style — consistent bullet marker across the docs.
 * `style?: "dash" | "asterisk"` (default `dash`). Auto-fixable: swap the
 * marker character on the offending list item.
 *
 * Detection is the `unorderedListMarker` detector (`../detectors.ts`),
 * given the chosen marker. The wrapper
 * re-walks the tree at each reported position to recover the listItem
 * offset for the surgical fix.
 */

import { findNodeAt } from "../parse.js";
import { unorderedListMarker } from "../detectors.js";
import type { Rule } from "../rule.js";

const MARKER = { dash: "-", asterisk: "*" } as const;

export const listMarkerStyle: Rule = {
  code: "nimbus/list-marker-style",
  run(ctx) {
    const style = ctx.options.style === "asterisk" ? "asterisk" : "dash";
    const want = MARKER[style];

    const reports = unorderedListMarker(ctx.file.tree, ctx.file.source, want);

    for (const r of reports) {
      const item = findNodeAt(ctx.file.tree, "listItem", r.line, r.column);
      const offset = item?.position?.start.offset;
      if (typeof offset !== "number") {
        ctx.report({
          ...r,
          message: `bullet marker should be "${want}".`,
        });
        continue;
      }
      const ch = ctx.file.source[offset];
      if (ch !== "-" && ch !== "*" && ch !== "+") {
        // Defensive: the offset doesn't land on a real marker character.
        ctx.report({
          ...r,
          message: `bullet marker should be "${want}".`,
        });
        continue;
      }

      ctx.report({
        ...r,
        message: `bullet uses "${ch}" — this project's list marker is "${want}".`,
        fix: {
          description: `change "${ch}" to "${want}"`,
          edits: [{ range: [offset, offset + 1], text: want }],
        },
      });
    }
  },
};
