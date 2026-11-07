/**
 * Which heading an API home click is going to, when the page can take it there
 * itself: an unmodified primary click on a `#heading` link, or on a link to one
 * of the home's later parts (same origin, path and query; only the fragment may
 * differ). Anything else is left to the browser: modified or non-primary clicks,
 * other pages, another version's part, and links that open elsewhere (`target`
 * other than `_self`) or download. A click another handler already cancelled
 * still counts: the client router cancels same-page hash links.
 */
export function homePartTarget(event: MouseEvent, partHrefs: readonly string[]): string | null {
  if (event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const anchor = (event.target as Element | null)?.closest?.("a");
  const href = anchor?.getAttribute("href");
  if (!anchor || !href) return null;
  const target = anchor.getAttribute("target");
  if ((target && target !== "_self") || anchor.hasAttribute("download")) return null;
  if (href.startsWith("#")) return heading(href);
  const url = new URL(href, location.href);
  if (!url.hash) return null;
  const sameDocument = (target: string) => {
    const part = new URL(target, location.href);
    return part.origin === url.origin && part.pathname === url.pathname && part.search === url.search;
  };
  return partHrefs.some(sameDocument) ? heading(url.hash) : null;
}

/** The heading id a `#fragment` names, or `null` for an empty or malformed one. */
function heading(hash: string): string | null {
  try {
    return decodeURIComponent(hash.slice(1)) || null;
  } catch {
    return null;
  }
}
