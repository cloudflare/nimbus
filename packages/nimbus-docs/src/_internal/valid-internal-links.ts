import { toRouteKey } from "./url.js";

// The set of valid internal route keys is a pure function of the indexed
// entries, which are cached for the whole build. Memoize by source identity
// so it's built once rather than per page; a new indexed array (after a cache
// clear) rebuilds it.
let cache: { source: readonly { url: string }[]; set: Set<string> } | undefined;

export function getValidInternalLinks(
  indexed: readonly { url: string }[],
): Set<string> {
  if (cache?.source === indexed) return cache.set;
  const set = new Set(indexed.map((e) => toRouteKey(e.url)));
  cache = { source: indexed, set };
  return set;
}

export function clearValidInternalLinksCache(): void {
  cache = undefined;
}
