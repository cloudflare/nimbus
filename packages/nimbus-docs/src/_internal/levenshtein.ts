/**
 * Tiny Levenshtein distance + "did you mean" suggester.
 *
 * Used by the MDX PascalCase validator and any framework diagnostic that
 * wants to suggest a near-match on a misspelled name. Kept internal — user
 * code that wants the same hint duplicates ~10 lines rather than depending
 * on a framework wrapper — we avoid shipping thin wrappers as public API.
 */

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const v0 = new Array<number>(b.length + 1);
  const v1 = new Array<number>(b.length + 1);
  // `!` on every indexed read: arrays are pre-allocated to length b.length+1
  // and every index used here is loop-bounded within that range.
  for (let i = 0; i <= b.length; i++) v0[i] = i;
  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j]! + 1, v0[j + 1]! + 1, v0[j]! + cost);
    }
    for (let j = 0; j <= b.length; j++) v0[j] = v1[j]!;
  }
  return v1[b.length]!;
}

/**
 * Return the closest candidate within `maxDist`, or null.
 *
 * Comparison is case-insensitive (so "tabs" suggests "Tabs"), but the
 * returned name keeps its original casing.
 */
export function suggest(
  target: string,
  candidates: Iterable<string>,
  maxDist = 3,
): string | null {
  const targetLower = target.toLowerCase();
  let best: { name: string; dist: number } | null = null;
  for (const c of candidates) {
    const dist = levenshtein(targetLower, c.toLowerCase());
    if (dist <= maxDist && (!best || dist < best.dist)) {
      best = { name: c, dist };
    }
  }
  return best?.name ?? null;
}
