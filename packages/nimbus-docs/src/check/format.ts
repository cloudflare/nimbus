/**
 * `check` output. The agent JSON envelope carries three top-level signals
 * (`ok` back-compat, `status`, `readiness`), a `summary` that now counts
 * `notes`, a per-scope `scopes[]` (derived status + notes + optional reason),
 * and the flat `findings[]`. The pretty form is a *lookup* from those signals,
 * never a guess from an error count: the scope glyph is `✗ / ○ / ✓` off
 * `status`, notes render as dim trailing text on a `✓` line, and the headline
 * says "Ready" / "Buildable" / "Couldn't fully verify" / "Not buildable"
 * strictly per the glyph rule.
 */

import type { CheckResult, ScopeResult } from "./run.js";
import type { CheckFinding, CheckScope, Note } from "./finding.js";

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
};

export interface PrettyOptions {
  color: boolean;
  quiet?: boolean;
  invocation: string;
}

const SCOPE_LABELS: Record<CheckScope, string> = {
  env: "Environment",
  structure: "Structure",
  migrations: "Migrations",
  authoring: "Authoring",
  types: "Types",
};

export function formatCheckJson(result: CheckResult): string {
  return JSON.stringify(
    {
      ok: result.ok,
      status: result.status,
      readiness: result.readiness,
      summary: {
        errors: result.summary.errors,
        warnings: result.summary.warnings,
        notes: result.summary.notes,
        fixable: result.summary.fixable,
        durationMs: result.summary.durationMs,
      },
      scopes: result.scopes.map((s) => ({
        scope: s.scope,
        status: s.status,
        ...(s.reason ? { reason: s.reason } : {}),
        notes: s.notes.map((n) => ({
          code: n.code,
          reason: n.reason,
          ...(n.requiresBuild ? { requiresBuild: true } : {}),
          ...(n.requiresInput ? { requiresInput: true } : {}),
        })),
      })),
      findings: result.findings.map((f) => ({
        scope: f.scope,
        code: f.code,
        severity: f.severity,
        ...(f.file ? { file: f.file } : {}),
        ...(f.line !== undefined ? { line: f.line } : {}),
        ...(f.column !== undefined ? { column: f.column } : {}),
        message: f.message,
        fixable: f.fixable,
        ...(f.fix ? { fix: f.fix } : {}),
        ...(f.migration ? { migration: f.migration } : {}),
      })),
    },
    null,
    2,
  );
}

export function formatCheckPretty(result: CheckResult, opts: PrettyOptions): string {
  const paint = (code: string, text: string) =>
    opts.color ? `${code}${text}${COLORS.reset}` : text;

  const lines: string[] = [""];
  for (const scope of result.scopes) {
    lines.push(...renderScope(scope, opts, paint));
  }

  lines.push("");
  lines.push(...renderHeadline(result, opts, paint));
  lines.push("");
  return lines.join("\n");
}

function renderScope(
  scope: ScopeResult,
  opts: PrettyOptions,
  paint: (code: string, text: string) => string,
): string[] {
  const label = SCOPE_LABELS[scope.scope].padEnd(14);
  const errors = scope.findings.filter((f) => f.severity === "error");
  const warns = opts.quiet ? [] : scope.findings.filter((f) => f.severity === "warn");

  if (scope.status === "failed" && errors.length > 0) {
    const [first, ...rest] = errors as [CheckFinding, ...CheckFinding[]];
    const out = [`  ${label}${paint(COLORS.red, "✗")} ${first.message}`];
    out.push(...findingDetail(first, paint));
    for (const f of [...rest, ...warns]) out.push(...renderFinding(f, paint));
    return out;
  }

  if (scope.status === "not_evaluated") {
    const reason = scope.reason ?? scope.notes[0]?.reason ?? "not evaluated";
    return [`  ${label}${paint(COLORS.yellow, "○")} not evaluated — ${paint(COLORS.dim, reason)}`];
  }

  const trailing = scope.notes.map((n) => noteTrail(n)).join(" · ");
  const summary = trailing
    ? `ok · ${paint(COLORS.dim, trailing)}`
    : "ok";
  const out = [`  ${label}${paint(COLORS.green, "✓")} ${summary}`];
  for (const f of warns) out.push(...renderFinding(f, paint));
  return out;
}

function noteTrail(note: Note): string {
  const suffix = note.requiresBuild ? " (needs a build)" : "";
  return `${note.reason}${suffix}`;
}

function renderFinding(
  f: CheckFinding,
  paint: (code: string, text: string) => string,
): string[] {
  const mark =
    f.severity === "error" ? paint(COLORS.red, "✗") : paint(COLORS.yellow, "!");
  return [`    ${mark} ${f.message}`, ...findingDetail(f, paint)];
}

function findingDetail(
  f: CheckFinding,
  paint: (code: string, text: string) => string,
): string[] {
  const loc = locationOf(f);
  const out = [`      ${paint(COLORS.dim, [loc, f.code].filter(Boolean).join("  "))}`];
  if (f.fix?.suggestion) {
    out.push(`      ${paint(COLORS.dim, `fix: ${f.fix.suggestion}`)}`);
  }
  return out;
}

function renderHeadline(
  result: CheckResult,
  opts: PrettyOptions,
  paint: (code: string, text: string) => string,
): string[] {
  const { durationMs } = result.summary;
  const secs = (durationMs / 1000).toFixed(durationMs < 100 ? 2 : 1);
  const checkedIn = paint(COLORS.dim, `    checked in ${secs}s`);

  if (result.status === "failed") {
    // "still builds" is asserted ONLY when buildability was actually verified.
    return result.readiness === "buildable"
      ? correctnessFailureHeadline(result, paint, checkedIn)
      : problemHeadline(result, opts, paint, checkedIn);
  }

  // `○` only when a build scope RAN and couldn't fully verify (a note) — not
  // when readiness is `unknown` merely because a scope subset omitted it.
  const buildNote = buildabilityNote(result);
  if (result.readiness === "unknown" && buildNote) {
    return [paint(COLORS.yellow, `  ○ Couldn't fully verify buildability — ${buildNote}`), checkedIn];
  }

  if (result.status === "passed") return passedHeadline(result, opts, secs, paint);
  return partialHeadline(result, secs, paint);
}

/**
 * `status: partial` — clean so far, but with coverage gaps. "Buildable" is only
 * honest when env + structure actually verified it (`readiness: buildable`); a
 * scope subset that omitted a build scope leaves readiness `unknown`, so it must
 * neither claim "Buildable" nor name an unrun scope as checked.
 */
function partialHeadline(
  result: CheckResult,
  secs: string,
  paint: (code: string, text: string) => string,
): string[] {
  const gaps = coverageGaps(result);
  const gapLine =
    gaps.length > 0
      ? paint(
          COLORS.dim,
          `    ${gaps.length} correctness check${gaps.length === 1 ? "" : "s"} not evaluated yet: ${gaps.join(", ")}`,
        )
      : null;

  if (result.readiness === "buildable") {
    const out = [paint(COLORS.green, `  ✓ Buildable — checked env + structure in ${secs}s`)];
    if (gapLine) {
      out.push(gapLine);
      out.push(paint(COLORS.dim, `    → run a build, then \`nimbus-docs check\` again`));
    }
    return out;
  }

  // Name only scopes that FULLY verified — a not_evaluated scope, or a passed
  // scope still carrying a coverage note, belongs in the gap line, never in a
  // "checked" claim. With nothing fully verified, don't ✓.
  const passed = result.scopes
    .filter((s) => s.status === "passed" && s.notes.length === 0)
    .map((s) => SCOPE_LABELS[s.scope]);
  const out =
    passed.length > 0
      ? [paint(COLORS.green, `  ✓ ${passed.join(" + ")} checked in ${secs}s`)]
      : [paint(COLORS.yellow, `  ○ Nothing fully verified yet — run a build, then \`nimbus-docs check\` again`)];
  if (gapLine) out.push(gapLine);
  return out;
}

function passedHeadline(
  result: CheckResult,
  opts: PrettyOptions,
  secs: string,
  paint: (code: string, text: string) => string,
): string[] {
  const { warnings } = result.summary;
  const advisory =
    warnings > 0 && !opts.quiet
      ? paint(COLORS.dim, ` (${warnings} advisory warning${warnings === 1 ? "" : "s"})`)
      : "";
  const { env, structure, authoring, types, migrations } = result.requested;
  const headline = env && structure && authoring && types && migrations !== false
    ? `  ✓ Ready — buildability + correctness passed in ${secs}s`
    : `  ✓ ${scopeList(result).join(" + ")} passed — checked in ${secs}s`;
  return [paint(COLORS.green, headline) + advisory];
}

function scopeList(result: CheckResult): string[] {
  return result.scopes.map((s) => SCOPE_LABELS[s.scope]);
}

function problemHeadline(
  result: CheckResult,
  opts: PrettyOptions,
  paint: (code: string, text: string) => string,
  checkedIn: string,
): string[] {
  const shown = result.summary.errors + (opts.quiet ? 0 : result.summary.warnings);
  // Count fixes only over the findings we actually surfaced: `--quiet` hides
  // warnings, so their fixes mustn't inflate the footer past the shown count.
  const visible = opts.quiet
    ? result.findings.filter((f) => f.severity === "error")
    : result.findings;
  const autoFixable = visible.filter((f) => f.fixable && !f.fix?.requiresInput).length;
  const needsInput = visible.filter((f) => f.fixable && f.fix?.requiresInput).length;

  const parts = [`${shown} problem${shown === 1 ? "" : "s"}`];
  if (autoFixable > 0) parts.push(`${autoFixable} auto-fixable`);
  if (needsInput > 0) parts.push(`${needsInput} need${needsInput === 1 ? "s" : ""} input`);

  // `blocked` is verified non-buildable; `unknown` is unverified — don't claim either.
  const lead = result.readiness === "blocked" ? "Not buildable — " : "";
  let head = `  ✗ ${lead}${parts.join(" · ")}`;
  if (autoFixable + needsInput > 0) head += ` → run \`${opts.invocation}\``;
  return [paint(COLORS.red, head), checkedIn];
}

function correctnessFailureHeadline(
  result: CheckResult,
  paint: (code: string, text: string) => string,
  checkedIn: string,
): string[] {
  const errors = result.findings.filter((f) => f.severity === "error");
  const allTypes = errors.length > 0 && errors.every((f) => f.scope === "types");
  const subject = allTypes
    ? `${errors.length} type error${errors.length === 1 ? "" : "s"}`
    : `${errors.length} problem${errors.length === 1 ? "" : "s"}`;
  const pronoun = errors.length === 1 ? "this" : "these";
  return [
    paint(COLORS.red, `  ✗ ${subject} — the site still builds, but fix ${pronoun}`),
    checkedIn,
  ];
}

/** The first env/structure note reason — why readiness is `unknown`. */
function buildabilityNote(result: CheckResult): string | null {
  for (const s of result.scopes) {
    if (s.scope !== "env" && s.scope !== "structure") continue;
    const note = s.notes[0];
    if (note) return note.reason;
  }
  return null;
}

/** Human labels for the correctness scopes that couldn't be fully evaluated. */
function coverageGaps(result: CheckResult): string[] {
  const labels: string[] = [];
  for (const s of result.scopes) {
    if (s.status === "not_evaluated") {
      labels.push(SCOPE_LABELS[s.scope].toLowerCase());
      continue;
    }
    for (const n of s.notes) labels.push(gapLabel(s.scope, n));
  }
  return labels;
}

function gapLabel(scope: CheckScope, note: Note): string {
  switch (note.code) {
    case "nimbus/authoring-optin-skipped":
      return "opt-in authoring rules";
    case "nimbus/internal-link-skipped":
      return "link checking";
    default:
      return SCOPE_LABELS[scope].toLowerCase();
  }
}

function locationOf(f: CheckFinding): string {
  if (!f.file) return "";
  if (f.line === undefined) return f.file;
  if (f.column === undefined) return `${f.file}:${f.line}`;
  return `${f.file}:${f.line}:${f.column}`;
}
