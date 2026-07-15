/**
 * The rule contract. A rule inspects one `ParsedFile` and reports zero or
 * more findings via `ctx.report`. The engine attaches `code`, `severity`,
 * `source`, and `file` — a rule only supplies the message, position, and
 * optional fix, so it can't lie about its own identity.
 */

import type { AuthoringRuleCode, DiagnosticFix } from "./diagnostic.js";
import type { ParsedFile } from "./parse.js";

export interface RuleReport {
  message: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  endLine?: number;
  endColumn?: number;
  fix?: DiagnosticFix;
}

export interface RuleContext {
  file: ParsedFile;
  /** Resolved options for this rule (the object half of the tuple form). */
  options: Record<string, unknown>;
  /**
   * The project's canonical site URL (from `nimbusConfig.site`), threaded
   * through by the engine for rules that need to compare against it (e.g.
   * `no-self-host-url` treating the deploy host as always-banned). Absent
   * when the engine is invoked outside an Astro integration context — e.g.
   * unit tests parsing a fixture directly.
   */
  site?: string;
  report(report: RuleReport): void;
}

export interface Rule {
  /** Authoring-rule code. Build validators don't go through this engine. */
  code: AuthoringRuleCode;
  run(ctx: RuleContext): void;
}
