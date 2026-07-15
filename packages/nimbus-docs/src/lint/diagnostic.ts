/**
 * The diagnostic envelope — the single shape every Nimbus check flows
 * through, from build validators to authoring rules to (eventually) Vale.
 *
 * The shape is stable: extending it later is a versioned schema bump, not a
 * field tacked on in a minor. Positions are the unist `Point` Sätteri's parser
 * already emits (1-based line/column plus a character offset), so a
 * diagnostic, a `--fix` edit range, and the pretty formatter's caret all
 * read from the one AST the renderer built.
 */

/**
 * The stable rule-code registry. Every code Nimbus can emit lives here,
 * tagged with the tier it belongs to:
 *
 *   - `build`    — a build validator. Always on, fails `astro build`, no
 *                  severity knob. Cannot appear in the `rules` config.
 *   - `authoring`— an authoring rule. Defaults to `off` (opt-in),
 *                  configurable to `warn` / `error`, surfaced by
 *                  `nimbus-docs lint`.
 *
 * Codes are registered here even before their rule is implemented so the
 * namespace is stable and `RuleCode` stays exhaustive: importing or
 * configuring an unknown code is a typecheck failure, not a silent no-op.
 */
export const RULE_CODES = {
  // Build validators — won't render → fail the build.
  "nimbus/mdx-syntax": { kind: "build" },
  "nimbus/component-pascalcase": { kind: "build" },
  "nimbus/partial-exists": { kind: "build" },
  "nimbus/duplicate-slug": { kind: "build" },

  // Authoring rules — renders fine, shouldn't ship.
  "nimbus/frontmatter-shape": { kind: "authoring" },
  "nimbus/description-required": { kind: "authoring" },
  "nimbus/internal-link": { kind: "authoring" },
  "nimbus/image-ref": { kind: "authoring" },
  "nimbus/orphan-page": { kind: "authoring" },
  "nimbus/sidebar-entry": { kind: "authoring" },
  "nimbus/single-h1": { kind: "authoring" },
  "nimbus/heading-hierarchy": { kind: "authoring" },
  "nimbus/code-block-lang": { kind: "authoring" },
  "nimbus/code-block-prompt-prefix": { kind: "authoring" },
  "nimbus/no-self-host-url": { kind: "authoring" },
  "nimbus/heading-punctuation": { kind: "authoring" },
  "nimbus/duplicate-heading-text": { kind: "authoring" },
  "nimbus/list-marker-style": { kind: "authoring" },
  "nimbus/emphasis-style": { kind: "authoring" },
  "nimbus/bare-url": { kind: "authoring" },
} as const satisfies Record<string, { kind: "build" | "authoring" }>;

/** Every rule code Nimbus knows about. */
export type RuleCode = keyof typeof RULE_CODES;

/**
 * Authoring-rule codes only — the subset that's user-configurable via
 * `rules: { ... }`. Build validators are excluded at the type level so
 * TS-using consumers can't write the invalid config the runtime would
 * throw on, and so autocomplete inside `astro.config.ts` never offers
 * `nimbus/mdx-syntax` and friends.
 */
export type AuthoringRuleCode = {
  [K in RuleCode]: (typeof RULE_CODES)[K] extends { kind: "authoring" }
    ? K
    : never;
}[RuleCode];

/** Resolved severity — a rule that resolved to `off` never runs, so it
 * never reaches a `Diagnostic`. */
export type Severity = "error" | "warn";

/** Severity as a user configures it. `off` disables the rule entirely. */
export type SeverityConfig = Severity | "off";

export interface DiagnosticFix {
  /** Human/agent-readable description of what the fix does. */
  description: string;
  /**
   * Edits to apply, as `[start, end]` character offsets into the source
   * (unist offsets — the same the AST reports), with replacement text.
   */
  edits: Array<{ range: [number, number]; text: string }>;
}

export interface Diagnostic {
  code: RuleCode;
  severity: Severity;
  /** Which tool produced this. Reserved so a future Vale integration can
   * merge into the same envelope without a breaking change. */
  source: "docs-compiler" | "vale";
  message: string;
  /** Path relative to the project root. */
  file: string;
  /** 1-based, from the Sätteri AST. */
  line: number;
  /** 1-based, from the Sätteri AST. */
  column: number;
  endLine?: number;
  endColumn?: number;
  fix?: DiagnosticFix;
}

/** True when `code` is a build validator (unconfigurable, build-failing). */
export function isBuildValidator(code: RuleCode): boolean {
  return RULE_CODES[code].kind === "build";
}

/** Every known authoring-rule code. */
export function authoringRuleCodes(): RuleCode[] {
  return (Object.keys(RULE_CODES) as RuleCode[]).filter(
    (c) => RULE_CODES[c].kind === "authoring",
  );
}

/** Type guard: is `value` a registered rule code? */
export function isRuleCode(value: string): value is RuleCode {
  return Object.prototype.hasOwnProperty.call(RULE_CODES, value);
}
