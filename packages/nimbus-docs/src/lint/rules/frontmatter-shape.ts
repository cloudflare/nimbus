/** nimbus/frontmatter-shape — report malformed YAML before other rules run. */

import type { Rule } from "../rule.js";

export const frontmatterShape: Rule = {
  code: "nimbus/frontmatter-shape",
  run(ctx) {
    const { frontmatter, frontmatterRaw, frontmatterStartLine } = ctx.file;

    // Raw frontmatter present but YAML parse failed — report that, since
    // every downstream check depends on a parseable object.
    if (frontmatter === null) {
      if (frontmatterRaw !== null) {
        ctx.report({
          message: "frontmatter is present but is not valid YAML.",
          line: frontmatterStartLine,
          column: 1,
        });
      }
      return;
    }

    // Collection schemas and transforms belong to Astro. The standalone
    // linter cannot evaluate a project's content.config safely.
  },
};
