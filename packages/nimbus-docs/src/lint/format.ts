/**
 * Diagnostic formatters: a pretty terminal form and a machine-readable
 * JSON form. The pretty form reads as —
 *
 *   src/content/docs/getting-started.mdx:42:18  error  nimbus/single-h1
 *     more than one top-level "#" heading …
 *
 * The JSON form is the agent-shaped envelope, validated against the
 * committed `diagnostic.schema.json`.
 */

import type { Diagnostic } from "./diagnostic.js";
import type { LintSummary } from "./engine.js";

const COLORS = {
  reset: "[0m",
  dim: "[2m",
  red: "[31m",
  yellow: "[33m",
  green: "[32m",
  bold: "[1m",
};

export interface FormatOptions {
  color: boolean;
  /** Suppress `warn`-severity diagnostics from the output. */
  quiet?: boolean;
}

export function formatPretty(
  diagnostics: Diagnostic[],
  summary: LintSummary,
  opts: FormatOptions,
): string {
  const paint = (code: string, text: string) =>
    opts.color ? `${code}${text}${COLORS.reset}` : text;

  const shown = opts.quiet
    ? diagnostics.filter((d) => d.severity === "error")
    : diagnostics;

  const lines: string[] = [];
  for (const d of shown) {
    const sev =
      d.severity === "error"
        ? paint(COLORS.red, "error")
        : paint(COLORS.yellow, "warn");
    const loc = paint(COLORS.dim, `${d.file}:${d.line}:${d.column}`);
    lines.push(`${loc}  ${sev}  ${paint(COLORS.dim, d.code)}`);
    lines.push(`  ${d.message}`);
    if (d.fix && d.fix.description) {
      lines.push(`  ${paint(COLORS.dim, `fix: ${d.fix.description}`)}`);
    }
  }

  if (summary.total === 0) {
    return paint(COLORS.green, `✓ ${summary.files} file(s) lint clean.`);
  }

  const tally = `${summary.errors} error(s), ${summary.warnings} warning(s) across ${summary.files} file(s)`;
  lines.push("");
  lines.push(
    summary.errors > 0
      ? paint(COLORS.red, `✗ ${tally}`)
      : paint(COLORS.yellow, `${tally}`),
  );
  return lines.join("\n");
}

export function formatJson(
  diagnostics: Diagnostic[],
  summary: LintSummary,
): string {
  return JSON.stringify(
    {
      version: 1,
      summary: {
        errors: summary.errors,
        warnings: summary.warnings,
        total: summary.total,
        files: summary.files,
      },
      diagnostics,
    },
    null,
    2,
  );
}
