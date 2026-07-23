/**
 * Minimal unified-diff renderer — bundled so `diff`/`outdated` never shell out
 * to `git` (which would inherit the user's diff.external/pager config and leak
 * temp paths). LCS line diff → grouped hunks with context. Zero deps.
 */

const ADD = "\x1b[32m";
const DEL = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

type Op = { kind: " " | "-" | "+"; line: string };

// Longest-common-subsequence line diff (O(n·m) DP — fine for source files).
function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "-", line: a[i]! });
      i++;
    } else {
      ops.push({ kind: "+", line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "-", line: a[i++]! });
  while (j < m) ops.push({ kind: "+", line: b[j++]! });
  return ops;
}

function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // trailing newline isn't a line
  return lines;
}

export interface UnifiedDiffOptions {
  path?: string;
  color?: boolean;
  context?: number;
}

/** `true` when the two texts differ (cheap; use before rendering). */
export function hasChanges(a: string, b: string): boolean {
  return a !== b;
}

/**
 * Render a unified diff of `a` → `b`. Returns "" when identical. Hunks carry
 * `context` unchanged lines around each change; a `path` sets the `--- / +++`
 * header (temp-file paths never appear).
 */
export function unifiedDiff(a: string, b: string, opts: UnifiedDiffOptions = {}): string {
  if (a === b) return "";
  const context = opts.context ?? 3;
  const color = opts.color ?? false;
  const ops = diffOps(splitLines(a), splitLines(b));

  // Group ops into hunks: runs of changes plus `context` surrounding common lines.
  const keep = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k]!.kind !== " ") {
      for (let d = -context; d <= context; d++) {
        if (k + d >= 0 && k + d < ops.length) keep[k + d] = true;
      }
    }
  }

  const paint = (s: string, c: string) => (color ? `${c}${s}${RESET}` : s);
  const out: string[] = [];
  if (opts.path) {
    out.push(paint(`--- ${opts.path}`, DEL), paint(`+++ ${opts.path}`, ADD));
  }

  // Emit each contiguous kept run as a hunk with a real line-range header.
  let aLine = 1;
  let bLine = 1;
  let k = 0;
  while (k < ops.length) {
    if (!keep[k]) {
      if (ops[k]!.kind !== "+") aLine++;
      if (ops[k]!.kind !== "-") bLine++;
      k++;
      continue;
    }
    const aStart = aLine;
    const bStart = bLine;
    let aCount = 0;
    let bCount = 0;
    const body: string[] = [];
    while (k < ops.length && keep[k]) {
      const op = ops[k]!;
      if (op.kind !== "+") aCount++;
      if (op.kind !== "-") bCount++;
      body.push(
        op.kind === "+"
          ? paint(`+${op.line}`, ADD)
          : op.kind === "-"
            ? paint(`-${op.line}`, DEL)
            : ` ${op.line}`,
      );
      k++;
    }
    aLine = aStart + aCount;
    bLine = bStart + bCount;
    out.push(paint(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`, DIM), ...body);
  }

  return out.join("\n");
}
