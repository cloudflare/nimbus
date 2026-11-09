/**
 * Read/write a single URL query param without disturbing the rest of the URL.
 *
 * `readUrlParam` also recovers a param stranded in the fragment — a hand-pasted
 * `…/page#anchor?key=value` puts `?key=` inside `location.hash`, not
 * `location.search`, so a search-only read would silently miss it.
 *
 * `writeUrlParam` canonicalises: it sets the param in the real query (before the
 * hash) via `history.replaceState`, preserving the anchor, any other params, and
 * the current `history.state`, and strips a stranded copy from the fragment so
 * the two never disagree. It no-ops when the URL would not change.
 *
 * `readUrlParam` is serialized into `choiceStateScript`, so it may reference
 * only browser globals and its argument.
 */

export function readUrlParam(name: string): string | null {
  const fromSearch = new URLSearchParams(location.search).get(name);
  if (fromSearch) return fromSearch;
  const qi = location.hash.indexOf("?");
  if (qi === -1) return null;
  return new URLSearchParams(location.hash.slice(qi + 1)).get(name) || null;
}

export function writeUrlParam(name: string, value: string): void {
  try {
    const url = new URL(location.href);

    const qi = url.hash.indexOf("?");
    if (qi !== -1) {
      const anchor = url.hash.slice(0, qi);
      const hashParams = new URLSearchParams(url.hash.slice(qi + 1));
      hashParams.delete(name);
      const rest = hashParams.toString();
      url.hash = rest ? `${anchor}?${rest}` : anchor === "#" ? "" : anchor;
    }

    url.searchParams.set(name, value);
    if (url.href === location.href) return;
    history.replaceState(history.state, "", url);
  } catch {}
}
