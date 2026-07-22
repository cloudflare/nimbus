/**
 * Glob-based `ignore` matching for lint rules that accept an `ignore:
 * string[]` option (`internal-link`, `image-ref`). Backed by `picomatch` —
 * full glob syntax (`**`, `*`, `{a,b}`, `?`, extglobs, …), not just the
 * exact-match-or-`prefix/**`-suffix matcher this replaces.
 *
 * The previous matcher was hand-rolled specifically to avoid the
 * `picomatch` dependency, and covered the common cases (`/api/**`,
 * `/changelog/**`) fine. It couldn't express an any-depth *leading*
 * wildcard — e.g. a two-star prefix immediately before `llms.txt` to match
 * that filename at any depth — though a real gap surfaced migrating a
 * site off `starlight-links-validator` (which validates the same shape of
 * `ignore` list via `picomatch` already), where the existing exclude list
 * had exactly that kind of pattern. Taking the dependency restores parity
 * with that prior tool's behavior rather than asking every migrating
 * project to flatten its exclude list down to what the minimal matcher
 * could express.
 *
 * Compiled matchers are cached per *raw* `ctx.options.ignore` array identity
 * (`WeakMap`) — that array is the same reference for the lifetime of a lint
 * run (it comes straight from the resolved rule config, not a per-file
 * clone), so a run across thousands of files compiles each rule's `ignore`
 * list once, not once per file.
 *
 * Callers must pass the *unfiltered* `ctx.options.ignore` value straight
 * through (not a `.filter()`'d copy) — filtering happens in here, once per
 * distinct array, precisely so the cache key stays stable. A caller-side
 * `.filter()` would allocate a new array on every call and silently turn
 * this into a no-op cache (miss on every file).
 */

import picomatch from "picomatch";

const cache = new WeakMap<object, (input: string) => boolean>();

const NEVER_MATCH = (): boolean => false;

/**
 * `dot: true` so patterns can match path segments that start with `.`
 * (e.g. `/.well-known/**`) — glob's dotfile convention doesn't apply to
 * URL paths, and a segment starting with `.` isn't meant to be hidden from
 * `**`/`*` here.
 */
const PICOMATCH_OPTIONS = { dot: true } as const;

function stripTrailingSlash(s: string): string {
  return s.length > 1 && s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Match `url` (already run through the caller's own normalization — no
 * `base` prefix, no trailing slash, no hash/query) against the rule's raw
 * `ignore` option.
 *
 * Patterns get their own trailing slash stripped before compiling, so an
 * old-style bare `"/api/"` entry (no `/**`) still matches `/api` exactly,
 * matching the previous matcher's behavior. Non-string entries are dropped
 * (same tolerance the old per-rule filtering had).
 */
export function matchesAnyIgnore(url: string, rawIgnore: unknown): boolean {
  if (!Array.isArray(rawIgnore) || rawIgnore.length === 0) return false;
  let isMatch = cache.get(rawIgnore);
  if (!isMatch) {
    const patterns = rawIgnore
      .filter((s): s is string => typeof s === "string")
      .map(stripTrailingSlash);
    isMatch =
      patterns.length === 0
        ? NEVER_MATCH
        : picomatch(patterns, PICOMATCH_OPTIONS);
    cache.set(rawIgnore, isMatch);
  }
  return isMatch(url);
}
