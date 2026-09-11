/**
 * `check` has three channels. `findings[]` are things we *evaluated* and flagged
 * (a superset of the lint `Diagnostic`). `notes[]` are sub-checks we *could not*
 * evaluate — a coverage gap, never a warning, never carrying a `fix`. `scopes[]`
 * is the derived per-scope verdict. A runner returns one `ScopeReport` carrying
 * all three plus an explicit `evaluated` flag, because a clean scope and a
 * not-run scope both have zero findings.
 *
 * Exit contract: 0 clean · 1 error-severity findings · 2 usage. `ok`, top-level
 * `status`, and the exit code share one source of truth (the error count);
 * warnings and coverage gaps never move the exit code.
 */

import { isBuildValidator, isRuleCode, type Diagnostic } from "../lint/diagnostic.js";

export type CheckScope = "env" | "structure" | "migrations" | "authoring" | "types";

export type CheckSeverity = "error" | "warn";

/** Per-scope verdict, derived from findings + `evaluated`. */
export type ScopeStatus = "passed" | "failed" | "not_evaluated";

/** Whole-run verdict across every scope that ran. */
export type TopStatus = "passed" | "failed" | "partial";

/** Buildability verdict, from the checks `astro build` gates on. */
export type Readiness = "buildable" | "blocked" | "unknown";

export interface CheckFix {
  kind: "set-config" | "install-dep" | "lint-fix" | "suggestion";
  path?: string;
  package?: string;
  dev?: boolean;
  requiresInput?: boolean;
  suggestion?: string;
}

export interface CheckFinding {
  scope: CheckScope;
  code: string;
  severity: CheckSeverity;
  file?: string;
  line?: number;
  column?: number;
  message: string;
  fixable: boolean;
  fix?: CheckFix;
  migration?: {
    id: string;
    introducedIn: string;
    state: "available" | "blocked";
    command: { bin: string; args: string[]; cwd: string; display: string };
  };
}

/** A sub-check that could not run. Not a finding; resolves by making something exist. */
export interface Note {
  code: string;
  reason: string;
  requiresBuild?: boolean;
  requiresInput?: boolean;
}

export interface ScopeReport {
  scope: CheckScope;
  findings: CheckFinding[];
  notes: Note[];
  /** Did the scope's core actually run? `false` only when it produced no verdict. */
  evaluated: boolean;
  /** Whole-scope not-evaluated reason (types pre-build); omitted otherwise. */
  reason?: string;
}

export interface CheckSummary {
  errors: number;
  warnings: number;
  notes: number;
  fixable: number;
  durationMs: number;
}

export function summarize(
  findings: readonly CheckFinding[],
  noteCount: number,
  durationMs: number,
): CheckSummary {
  let errors = 0;
  let warnings = 0;
  let fixable = 0;
  for (const f of findings) {
    if (f.severity === "error") errors++;
    else warnings++;
    if (f.fixable) fixable++;
  }
  return { errors, warnings, notes: noteCount, fixable, durationMs };
}

export function exitCodeFor(summary: CheckSummary): 0 | 1 {
  return summary.errors > 0 ? 1 : 0;
}

function scopeHasError(r: ScopeReport): boolean {
  return r.findings.some((f) => f.severity === "error");
}

export function deriveScopeStatus(r: ScopeReport): ScopeStatus {
  if (scopeHasError(r)) return "failed";
  if (!r.evaluated) return "not_evaluated";
  return "passed";
}

/**
 * A finding that fails `astro build`: any env/structure error, or a
 * build-validator code (`kind: "build"`) from any scope. Build validators are
 * emitted through the authoring lint path (`fromDiagnostic` tags them
 * `authoring`), so scope alone would miss `mdx-syntax` / `partial-exists` and
 * let readiness claim "buildable" for a project that can't build.
 */
function isBuildBreaking(f: CheckFinding): boolean {
  if (f.severity !== "error") return false;
  if (f.scope === "env" || f.scope === "structure" || f.scope === "migrations") return true;
  return isRuleCode(f.code) && isBuildValidator(f.code);
}

/**
 * Buildability from the checks the build gates on: env, structure, and any
 * build-validator finding. `buildable` requires env + structure to both run
 * clean and gap-free and no build-breaking finding anywhere.
 */
export function deriveReadiness(reports: readonly ScopeReport[]): Readiness {
  if (reports.some((r) => r.findings.some(isBuildBreaking))) return "blocked";
  const build = reports.filter((r) => r.scope === "env" || r.scope === "structure");
  const bothRan =
    build.some((r) => r.scope === "env") && build.some((r) => r.scope === "structure");
  if (!bothRan || build.some((r) => !r.evaluated || r.notes.length > 0)) return "unknown";
  return "buildable";
}

/** Whole-run status across every scope that ran. */
export function deriveTopStatus(reports: readonly ScopeReport[]): TopStatus {
  if (reports.some(scopeHasError)) return "failed";
  if (reports.some((r) => !r.evaluated || r.notes.length > 0)) return "partial";
  return "passed";
}

export function fromDiagnostic(d: Diagnostic): CheckFinding {
  const hasEdits = d.fix !== undefined && d.fix.edits.length > 0;
  const fix: CheckFix | undefined = d.fix
    ? hasEdits
      ? { kind: "lint-fix", suggestion: d.fix.description }
      : { kind: "suggestion", suggestion: d.fix.description }
    : undefined;
  return {
    scope: "authoring",
    code: d.code,
    severity: d.severity,
    file: d.file,
    line: d.line,
    column: d.column,
    message: d.message,
    fixable: hasEdits,
    ...(fix ? { fix } : {}),
  };
}

export function sortFindings(findings: CheckFinding[]): CheckFinding[] {
  const scopeRank: Record<CheckScope, number> = {
    env: 0,
    structure: 1,
    migrations: 2,
    authoring: 3,
    types: 4,
  };
  return findings.sort(
    (a, b) =>
      scopeRank[a.scope] - scopeRank[b.scope] ||
      (a.file ?? "").localeCompare(b.file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0) ||
      a.code.localeCompare(b.code),
  );
}
