/**
 * nimbus/bare-url — a naked external URL in prose reads worse than a
 * descriptive link and is easy to mis-click. Flags GFM autolink literals
 * (`https://…`, `www.…`, emails written straight into prose). Explicit
 * `[text](url)` links pass, even when the text is the URL. Not auto-fixed:
 * good link text needs judgment.
 *
 * Detection is the `literalUrls` detector (`../detectors.ts`).
 */

import { literalUrls } from "../detectors.js";
import type { Rule } from "../rule.js";

export const bareUrl: Rule = {
  code: "nimbus/bare-url",
  run(ctx) {
    const reports = literalUrls(ctx.file.tree, ctx.file.source);
    for (const r of reports) {
      ctx.report({
        ...r,
        message:
          "bare URL in prose — wrap it in descriptive link text: [what it is](url).",
      });
    }
  },
};
