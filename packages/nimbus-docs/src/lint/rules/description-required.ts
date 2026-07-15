/**
 * nimbus/description-required — every page needs a non-empty `description`.
 *
 * Distinct from `frontmatter-shape`: the framework schema marks
 * `description` as optional (so it doesn't fail the build), but a missing
 * description hurts SEO and agent indexing — a quality opinion the lint
 * carries.
 *
 * Partials are typically embedded fragments rather than pages, so projects
 * usually want to exempt them. That exemption is **configured**, not
 * hardcoded — use `collections.partials.rules: { "nimbus/description-required":
 * "off" }` in `nimbus(config, …)`. The rule itself stays collection-agnostic
 * so per-collection overrides can opt in or out per project.
 *
 * Not auto-fixable: a good description needs judgment, so the guidance
 * lives in the message rather than a synthesized `fix`.
 */

import type { Rule } from "../rule.js";

export const descriptionRequired: Rule = {
  code: "nimbus/description-required",
  run(ctx) {
    const frontmatter = ctx.file.frontmatter;
    // The unparseable / absent-YAML case belongs to frontmatter-shape.
    if (frontmatter === null) return;

    const description = frontmatter.description;
    if (typeof description !== "string" || description.trim() === "") {
      ctx.report({
        message:
          'missing a non-empty "description" — add a one-sentence summary used for SEO meta tags and agent indexing.',
        line: ctx.file.frontmatterStartLine,
        column: 1,
      });
    }
  },
};
