/**
 * Glob matching for the `ignore: string[]` option (`internal-link`,
 * `image-ref`). Backed by `picomatch` — full glob syntax (`**`, `*`,
 * `{a,b}`, `?`, extglobs, …), not just exact match or `prefix/**`.
 *
 * Why picomatch, not hand-rolled:
 * - Previous matcher covered `/api/**`, `/changelog/**` fine.
 * - Couldn't express a leading any-depth wildcard (e.g. match `llms.txt`
 *   at any depth).
 * - Real gap: migrating off `starlight-links-validator` (already
 *   picomatch-backed) — its exclude list used exactly that pattern.
 * - Taking the dependency restores parity instead of flattening every
 *   migrating project's exclude list to fit the minimal matcher.
 *
 * Caching contract:
 * - Compiled matchers cached per *raw* `ctx.options.ignore` array identity
 *   (`WeakMap`).
 * - That array is the same reference for the life of a lint run (from
 *   resolved rule config, not per-file).
 * - So: one compile per run, not one per file.
 * - Callers must pass the array through **unfiltered** — filtering happens
 *   in here. A caller-side `.filter()` allocates a new array per call,
 *   which breaks the cache key and silently turns this into a no-op cache.
 */

import picomatch from "picomatch";

const cache = new WeakMap<object, (input: string) => boolean>();

const NEVER_MATCH = (): boolean => false;

// `dot: true` — glob's dotfile convention doesn't apply to URL paths.
// Without it, `/.well-known/**` wouldn't match its own segments.
const PICOMATCH_OPTIONS = { dot: true } as const;

function stripTrailingSlash(s: string): string {
  return s.length > 1 && s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Match `url` against the rule's raw `ignore` option.
 *
 * - `url` must already be normalized by the caller (no `base` prefix, no
 *   trailing slash, no hash/query).
 * - Each pattern gets its trailing slash stripped before compiling, so a
 *   bare `"/api/"` (no `/**`) still matches `/api` exactly — same as the
 *   previous matcher.
 * - Non-string and empty-string entries are dropped — `picomatch("")`
 *   throws, which would silently disable the whole rule (the engine skips a
 *   throwing rule). The old matcher tolerated `""`; this keeps that.
 */
export function matchesAnyIgnore(url: string, rawIgnore: unknown): boolean {
  if (!Array.isArray(rawIgnore) || rawIgnore.length === 0) return false;
  let isMatch = cache.get(rawIgnore);
  if (!isMatch) {
    const patterns = rawIgnore
      .filter((s): s is string => typeof s === "string" && s !== "")
      .map(stripTrailingSlash);
    isMatch =
      patterns.length === 0
        ? NEVER_MATCH
        : picomatch(patterns, PICOMATCH_OPTIONS);
    cache.set(rawIgnore, isMatch);
  }
  return isMatch(url);
}
