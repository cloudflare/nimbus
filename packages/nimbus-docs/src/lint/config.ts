/**
 * Lint configuration: the user-facing `rules` shape, severity resolution
 * for the engine, and the integration-side validator that enforces the
 * build/lint split at config time.
 *
 * The build / lint split is enforced here, not by convention: setting a
 * severity on a build validator, or using the reserved `collections` key,
 * is a typed, message-bearing failure — never a silent no-op.
 */

import {
  RULE_CODES,
  authoringRuleCodes,
  isBuildValidator,
  isRuleCode,
  type AuthoringRuleCode,
  type RuleCode,
  type SeverityConfig,
} from "./diagnostic.js";

/** A single rule's config: a bare severity, or `[severity, options]`. */
export type RuleSetting =
  | SeverityConfig
  | [SeverityConfig, Record<string, unknown>];

/**
 * The `rules` option: authoring code → setting. Build validators don't appear
 * here — they have no severity knob (the runtime validator throws on misuse,
 * the type prevents the misuse from being writable in the first place).
 */
export type RulesConfig = Partial<Record<AuthoringRuleCode, RuleSetting>>;

/** Per-collection lint config — currently just `rules` overrides. */
export interface CollectionLintConfig {
  rules?: RulesConfig;
}

/**
 * The `collections` option: collection name → per-collection overrides.
 * Each entry's `rules` shallow-merges over the top-level `rules` for
 * files in that collection. Per-rule resolution precedence is:
 * top-level defaults → per-collection → per-file `nimbusDisableRules`
 * → per-line inline disable. Each layer narrows scope.
 */
export type CollectionsConfig = Record<string, CollectionLintConfig>;

export interface ResolvedRule {
  severity: SeverityConfig;
  options: Record<string, unknown>;
}

/**
 * Default for an authoring rule with no explicit config: **off**. Nimbus
 * is opt-in by design — `rules: {}` means "no authoring rules run"; the
 * project enables what it wants. The scaffolded starter ships with
 * `nimbus/frontmatter-shape` and `nimbus/internal-link` turned on in its
 * `astro.config.ts`, visible and editable.
 *
 * The `--rule=<code>` CLI flag overrides this for the targeted rule (see
 * `engine.ts`) — otherwise running the CLI to inspect an off-by-default
 * rule would silently print nothing.
 */
const DEFAULT_AUTHORING_SEVERITY: SeverityConfig = "off";

/** Resolve the effective severity + options for an authoring rule. */
export function resolveRule(code: AuthoringRuleCode, rules: RulesConfig): ResolvedRule {
  const setting = rules[code];
  if (setting === undefined) {
    return { severity: DEFAULT_AUTHORING_SEVERITY, options: {} };
  }
  if (Array.isArray(setting)) {
    return { severity: setting[0], options: setting[1] ?? {} };
  }
  return { severity: setting, options: {} };
}

/**
 * Resolve a rule with an optional per-collection override layer.
 * Shallow-merges per rule code — a collection-level setting fully
 * replaces the top-level one for that code, options included (we don't
 * deep-merge option bags, since a partial override would silently drop
 * defaults the user can't see). The caller passes `collection` from
 * `file.collection`; when null or unconfigured, behaves like
 * `resolveRule` over just the top-level config.
 */
export function resolveRuleForCollection(
  code: AuthoringRuleCode,
  rules: RulesConfig,
  collections: CollectionsConfig,
  collection: string | null,
): ResolvedRule {
  const collectionRules =
    (collection !== null && collections[collection]?.rules) || undefined;
  if (collectionRules && code in collectionRules) {
    return resolveRule(code, collectionRules);
  }
  return resolveRule(code, rules);
}

export interface ValidatedLintOptions {
  rules: RulesConfig;
  collections: CollectionsConfig;
}

/**
 * Validate the lint half of the integration options
 * (`nimbus(config, { rules, collections })`). Throws a content-author
 * readable error on the first structural problem. Returns the normalized
 * `rules` config on success.
 *
 * When `implementedCodes` is supplied, also fails on authoring rules that
 * are registered in `RULE_CODES` but not yet wired to a rule module —
 * configuring a non-existent rule is a footgun (silent no-op) that should
 * surface as a typed error, not be discovered later when the rule never
 * fires. The caller (the integration) passes `IMPLEMENTED_CODES` here;
 * standalone callers (the CLI's own materialized-config loader, tests
 * exercising shape validation) may omit it.
 */
export function validateLintOptions(input: {
  rules?: unknown;
  collections?: unknown;
}, implementedCodes?: ReadonlySet<RuleCode>): ValidatedLintOptions {
  const rules = validateRulesBlock(input.rules, "rules", implementedCodes);
  const collections = validateCollectionsBlock(
    input.collections,
    implementedCodes,
  );
  return { rules, collections };
}

/**
 * Validate a `rules` block — used both for the top-level `rules` option
 * and the per-collection `collections.<name>.rules` block. `where`
 * identifies the block in error messages so the user knows which one to
 * fix (e.g. `rules` vs `collections.docs.rules`).
 */
function validateRulesBlock(
  rawRules: unknown,
  where: string,
  implementedCodes: ReadonlySet<RuleCode> | undefined,
): RulesConfig {
  if (rawRules === undefined) return {};
  if (typeof rawRules !== "object" || rawRules === null || Array.isArray(rawRules)) {
    throw new Error(
      `nimbus-docs: \`${where}\` must be an object mapping rule codes to a severity ("error" | "warn" | "off") or a [severity, options] tuple.`,
    );
  }

  const rules = rawRules as Record<string, unknown>;
  for (const [code, setting] of Object.entries(rules)) {
    if (!isRuleCode(code)) {
      throw new Error(
        `nimbus-docs: unknown rule code "${code}" in \`${where}\`. ` +
          `Valid authoring rules: ${authoringRuleCodes().join(", ")}.`,
      );
    }
    if (isBuildValidator(code)) {
      throw new Error(
        `nimbus-docs: "${code}" is a build validator — it has no severity knob and can't appear in \`${where}\`. ` +
          "It either passes or the build fails. To skip it on a specific file, use a per-file `nimbusDisableRules` entry or an inline disable comment instead.",
      );
    }
    const severity = Array.isArray(setting) ? setting[0] : setting;
    if (severity !== "error" && severity !== "warn" && severity !== "off") {
      throw new Error(
        `nimbus-docs: "${code}" in \`${where}\` has an invalid severity ${JSON.stringify(severity)}. Use "error", "warn", or "off"` +
          ' (optionally as a tuple: ["error", { /* options */ }]).',
      );
    }
    if (Array.isArray(setting) && setting[1] !== undefined &&
        (typeof setting[1] !== "object" || setting[1] === null)) {
      throw new Error(
        `nimbus-docs: the options half of the tuple for "${code}" in \`${where}\` must be an object, e.g. ["error", { allow: ["mermaid"] }].`,
      );
    }
    if (implementedCodes && !implementedCodes.has(code) && severity !== "off") {
      throw new Error(
        `nimbus-docs: "${code}" is registered but not yet implemented — configuring it as "${severity}" in \`${where}\` would silently do nothing. ` +
          "Remove the entry, or set it to \"off\" to silence the warning if you're forward-configuring for a future release.",
      );
    }
  }
  return rules as RulesConfig;
}

/**
 * Validate the `collections` block. Each value is a `{ rules?: ... }`
 * object whose `rules` follow the same shape as the top-level `rules`
 * option — including the build-validator carve-out (build validators
 * stay global; they can't be configured per-collection).
 */
function validateCollectionsBlock(
  rawCollections: unknown,
  implementedCodes: ReadonlySet<RuleCode> | undefined,
): CollectionsConfig {
  if (rawCollections === undefined) return {};
  if (
    typeof rawCollections !== "object" ||
    rawCollections === null ||
    Array.isArray(rawCollections)
  ) {
    throw new Error(
      'nimbus-docs: `collections` must be an object mapping collection names to a `{ rules: {…} }` block.',
    );
  }
  const out: CollectionsConfig = {};
  for (const [name, raw] of Object.entries(
    rawCollections as Record<string, unknown>,
  )) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(
        `nimbus-docs: \`collections.${name}\` must be an object, e.g. \`{ rules: { "nimbus/single-h1": "off" } }\`.`,
      );
    }
    const block = raw as { rules?: unknown };
    const rules = validateRulesBlock(
      block.rules,
      `collections.${name}.rules`,
      implementedCodes,
    );
    out[name] = { rules };
  }
  return out;
}

/** Codes registered but not yet wired to a rule implementation. Used by the
 * CLI to avoid silently claiming coverage it doesn't have. */
export function isImplemented(code: RuleCode, implemented: ReadonlySet<RuleCode>): boolean {
  return implemented.has(code) && code in RULE_CODES;
}
