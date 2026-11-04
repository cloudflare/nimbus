/**
 * Which heading an API home click is going to, when the page can take it there
 * itself: an unmodified primary click on a `#heading` link, or on a link to one
 * of the home's later parts (same origin, path and query; only the fragment may
 * differ). Anything else is left to the browser: modified or non-primary clicks,
 * other pages, another version's part. A click another handler already
 * cancelled still counts: the client router cancels same-page hash links.
 */
export function homePartTarget(event: MouseEvent, partHrefs: readonly string[]): string | null {
  if (event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const anchor = (event.target as Element | null)?.closest?.("a");
  const href = anchor?.getAttribute("href");
  if (!href) return null;
  if (href.startsWith("#")) return decodeURIComponent(href.slice(1)) || null;
  const url = new URL(href, location.href);
  if (!url.hash) return null;
  const sameDocument = (target: string) => {
    const part = new URL(target, location.href);
    return part.origin === url.origin && part.pathname === url.pathname && part.search === url.search;
  };
  return partHrefs.some(sameDocument) ? decodeURIComponent(url.hash.slice(1)) || null : null;
}
