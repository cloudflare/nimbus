/**
 * nimbus/heading-punctuation — headings shouldn't end in trailing
 * punctuation (`.`, `,`, `:`, `;`, `!`). Question marks are allowed —
 * "How do I…?" is a legitimate heading. Auto-fixable: strip the trailing
 * punctuation.
 *
 * Detection is delegated to `remark-lint-no-heading-punctuation` via the
 * adapter. The plugin's default disallowed set is `.,;:!?`; we override
 * with `.,;:!` so `?` headings stay legitimate — the policy lives in the
 * plugin's options, not in a post-filter that would silently mask any
 * future detection improvement.
 *
 * The wrapper re-walks the tree at each reported position to recover the
 * heading node, then builds the dynamic message (which names the trailing
 * punct) and the surgical fix (which strips it).
 */

import remarkLintNoHeadingPunctuation from "remark-lint-no-heading-punctuation";

import { collect, findNodeAt, textOf } from "../parse.js";
import { runRemarkLintRule } from "../remark-lint-adapter.js";
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
    const reports = runRemarkLintRule(
      remarkLintNoHeadingPunctuation,
      ctx.file.tree,
      {
        path: ctx.file.path,
        source: ctx.file.source,
        // Pin the disallowed set — default is `.,;:!?`; we drop `?`.
        settings: [DISALLOWED],
      },
    );

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
        // remark-lint flagged the heading but our text walk can't find
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
