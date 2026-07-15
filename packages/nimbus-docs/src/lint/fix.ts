/**
 * Apply rule `fix` edits to source. Diagnostic-level atomic: each
 * diagnostic's edits are applied together or not at all, and a diagnostic
 * whose span overlaps one already applied is skipped (a second pass picks
 * it up). Edits are character offsets into the source — the same unist
 * offsets the parser reports — applied right-to-left so earlier offsets
 * stay valid.
 *
 * No "smart" fixes: this only applies edits a rule already declared. The
 * change is plain and reviewable in `git diff`.
 */

import type { Diagnostic } from "./diagnostic.js";

export interface FixResult {
  output: string;
  /** Number of diagnostics whose fix was applied. */
  fixed: number;
  /**
   * The exact diagnostic objects whose fixes were applied. The caller
   * uses this (by identity, not by index) to know which diagnostics to
   * suppress from the post-fix report — the rest stay in the output
   * because their `fix` field was advisory-only (no edits) or was
   * skipped due to an overlap with another applied fix.
   */
  applied: Set<Diagnostic>;
}

export function applyFixes(source: string, diagnostics: Diagnostic[]): FixResult {
  const items = diagnostics
    .filter(
      (d): d is Diagnostic & { fix: NonNullable<Diagnostic["fix"]> } =>
        d.fix !== undefined && d.fix.edits.length > 0,
    )
    .map((d) => {
      const edits = d.fix.edits;
      return {
        diagnostic: d,
        edits,
        start: Math.min(...edits.map((e) => e.range[0])),
        end: Math.max(...edits.map((e) => e.range[1])),
      };
    })
    // Apply from the end of the file backwards.
    .sort((a, b) => b.start - a.start);

  let output = source;
  let frontier = Number.POSITIVE_INFINITY;
  const applied = new Set<Diagnostic>();

  for (const item of items) {
    if (item.end > frontier) continue; // overlaps an already-applied span
    const ordered = [...item.edits].sort((a, b) => b.range[0] - a.range[0]);
    for (const edit of ordered) {
      output =
        output.slice(0, edit.range[0]) + edit.text + output.slice(edit.range[1]);
    }
    frontier = item.start;
    applied.add(item.diagnostic);
  }

  return { output, fixed: applied.size, applied };
}
