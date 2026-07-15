/**
 * Internal barrel for the lint engine. The CLI imports from here; the
 * public `Diagnostic` type is re-exported from `nimbus-docs/types`.
 */

export {
  RULE_CODES,
  isBuildValidator,
  isRuleCode,
  authoringRuleCodes,
  type Diagnostic,
  type DiagnosticFix,
  type RuleCode,
  type Severity,
  type SeverityConfig,
} from "./diagnostic.js";
export {
  resolveRule,
  resolveRuleForCollection,
  validateLintOptions,
  type CollectionLintConfig,
  type CollectionsConfig,
  type RulesConfig,
  type RuleSetting,
  type ValidatedLintOptions,
} from "./config.js";
export {
  lintFile,
  lintPaths,
  fixPaths,
  summarize,
  type FixRunResult,
  type LintOptions,
  type LintSummary,
} from "./engine.js";
export { parseSource, type ParsedFile } from "./parse.js";
export { applyFixes, type FixResult } from "./fix.js";
export { findMdxFiles } from "./discover.js";
export { formatJson, formatPretty, type FormatOptions } from "./format.js";
export { IMPLEMENTED_CODES, RULES } from "./rules/index.js";
