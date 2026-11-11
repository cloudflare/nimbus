/**
 * The rule contract. A rule inspects one `ParsedFile` and reports zero or
 * more findings via `ctx.report`. The engine attaches `code`, `severity`,
 * `source`, and `file` — a rule only supplies the message, position, and
 * optional fix, so it can't lie about its own identity.
 */

import type { SourceCollection } from "../_internal/source-links.js";

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
  /**
   * Lower this finding to a warning whatever the configured severity. A rule
   * can only lower a finding, never raise it: `internal-link` uses it for
   * links into another slice of a partial build, which are advisory.
   */
  severity?: "warn";
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
  /** The deployment base in the renderer's form (`"/docs"`, `""` at the root). */
  base?: string;
  /** The folder and pattern of the file's content-source collection; unset for any other file. */
  sourceCollection?: SourceCollection;
  /** Another rule's resolved options for this file, so related rules agree. */
  optionsOf?(code: AuthoringRuleCode): Record<string, unknown>;
  report(report: RuleReport): void;
}

export interface Rule {
  /** Authoring-rule code. Build validators don't go through this engine. */
  code: AuthoringRuleCode;
  run(ctx: RuleContext): void;
}
