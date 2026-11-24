/**
 * nimbus/heading-punctuation — headings shouldn't end in trailing
 * punctuation (`.`, `,`, `:`, `;`, `!`). Question marks are allowed —
 * "How do I…?" is a legitimate heading. Auto-fixable: strip the trailing
 * punctuation.
 *
 * Detection is the `headingPunctuation` detector (`../detectors.ts`), given
 * the disallowed set `.,;:!` so `?` headings stay legitimate: the policy is
 * the detector's input, not a post-filter that could mask a detection.
 *
 * The wrapper re-walks the tree at each reported position to recover the
 * heading node, then builds the dynamic message (which names the trailing
 * punct) and the surgical fix (which strips it).
 */

import { collect, findNodeAt, textOf } from "../parse.js";
import { headingPunctuation as trailingPunctuation } from "../detectors.js";
import type { Rule } from "../rule.js";

/** Punctuation the rule treats as offending — `?` is intentionally absent. */
const DISALLOWED = ".,;:!";

/** Matches a run of disallowed chars at the end of a string. */
const TRAILING = new RegExp(
  `[${DISALLOWED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}]+$`,
);

export const headingPunctuation: Rule = {
  code: "nimbus/heading-punctuation",
  run(ctx) {
    const reports = trailingPunctuation(ctx.file.tree, new RegExp(`[${DISALLOWED}]`, "u"));

    for (const r of reports) {
      const heading = findNodeAt(ctx.file.tree, "heading", r.line, r.column);
      if (!heading) {
        // Defensive: position drift means we can't reconstruct the
        // dynamic message or the fix. Emit the rule's generic message
        // rather than swallow the diagnostic.
        ctx.report({
          ...r,
          message:
            "heading ends with trailing punctuation — drop it from the heading.",
        });
        continue;
      }

      const texts = collect(heading, "text");
      const last = texts[texts.length - 1];
      const value = typeof last?.value === "string" ? last.value : "";
      const match = value.match(TRAILING);
      const end = last?.position?.end.offset;

      if (!match || typeof end !== "number") {
        // The detector flagged the heading but our text walk can't find
        // the trailing punct on the last text node — likely because the
        // heading ends with an inline node we don't peer into (a code
        // span, link text, etc.). Emit the diagnostic without a fix.
        ctx.report({
          ...r,
          message: `heading "${textOf(heading).trim()}" ends with trailing punctuation — drop it from the heading.`,
        });
        continue;
      }

      const punct = match[0];
      ctx.report({
        ...r,
        message: `heading "${textOf(heading).trim()}" ends with "${punct}" — drop trailing punctuation from headings.`,
        fix: {
          description: `remove the trailing "${punct}"`,
          edits: [{ range: [end - punct.length, end], text: "" }],
        },
      });
    }
  },
};
