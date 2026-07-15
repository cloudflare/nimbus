/**
 * nimbus/frontmatter-shape — validate frontmatter against the framework's
 * content schema via the Zod-to-diagnostic adapter.
 *
 * Runs in *lenient* (passthrough) mode: it checks the types of the fields
 * Nimbus owns (title is a string, draft is a boolean, sidebar.order is a
 * number, …) but tolerates user-added fields, because the standalone CLI
 * can't yet see a site's extended `content.config.ts` schema. Lint
 * directive keys (`nimbusDisableRules`) are stripped before validation —
 * they're tooling, not content.
 */

import { lenientDocsSchema, lenientPartialsSchema } from "../../schemas.js";
import type { Rule } from "../rule.js";
import { zodErrorToReports } from "../zod-adapter.js";

const LINT_DIRECTIVE_KEYS = ["nimbusDisableRules"];

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

    const subject: Record<string, unknown> = { ...frontmatter };
    for (const key of LINT_DIRECTIVE_KEYS) delete subject[key];

    const schema =
      ctx.file.collection === "partials"
        ? lenientPartialsSchema
        : lenientDocsSchema;

    const result = schema.safeParse(subject);
    if (!result.success) {
      const reports = zodErrorToReports(result.error, {
        frontmatterRaw: frontmatterRaw ?? "",
        frontmatterStartLine,
      });
      for (const report of reports) ctx.report(report);
    }
  },
};
