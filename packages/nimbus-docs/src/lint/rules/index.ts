/**
 * The rule registry. Authoring rules implemented so far span the content
 * shape, markdown formatting, and route awareness (`internal-link`). The
 * remaining sidebar-aware rules (`orphan-page`, `sidebar-entry`) and build
 * validators land in later increments.
 */

import type { RuleCode } from "../diagnostic.js";
import type { Rule } from "../rule.js";
import { bareUrl } from "./bare-url.js";
import { codeBlockLang } from "./code-block-lang.js";
import { codeBlockPromptPrefix } from "./code-block-prompt-prefix.js";
import { descriptionRequired } from "./description-required.js";
import { duplicateHeadingText } from "./duplicate-heading-text.js";
import { emphasisStyle } from "./emphasis-style.js";
import { frontmatterShape } from "./frontmatter-shape.js";
import { headingHierarchy } from "./heading-hierarchy.js";
import { headingPunctuation } from "./heading-punctuation.js";
import { imageRef } from "./image-ref.js";
import { internalLink } from "./internal-link.js";
import { listMarkerStyle } from "./list-marker-style.js";
import { noSelfHostUrl } from "./no-self-host-url.js";
import { singleH1 } from "./single-h1.js";

export const RULES: Rule[] = [
  // Content shape
  frontmatterShape,
  descriptionRequired,
  singleH1,
  headingHierarchy,
  codeBlockLang,
  codeBlockPromptPrefix,
  noSelfHostUrl,
  // Markdown formatting
  headingPunctuation,
  duplicateHeadingText,
  listMarkerStyle,
  emphasisStyle,
  bareUrl,
  // Route-aware
  internalLink,
  imageRef,
];

/** Codes with a wired implementation (a subset of `RULE_CODES`). */
export const IMPLEMENTED_CODES: ReadonlySet<RuleCode> = new Set(
  RULES.map((r) => r.code),
);
