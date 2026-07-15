/**
 * Internal URL helpers — one shape for matching, one shape for rendering.
 *
 * Static hosts that serve `page/index.html` (Astro's default `build.format:
 * "directory"`) canonicalize to a trailing-slash URL. If framework helpers
 * emit slashless hrefs, every sidebar click costs a 307 redirect before
 * Astro's client router can pick up the page. The fix splits href shape
 * into two forms:
 *
 *   - `toRouteKey(href)` — slashless canonical form. Used wherever the
 *     framework compares paths for identity (active sidebar state,
 *     prev/next lookup, validation against the indexed route set).
 *
 *   - `toBrowserHref(href)` — what we emit into `<a href>` / `<link>` for
 *     HTML document routes. Adds a trailing slash so the URL matches the
 *     directory-index page the host serves directly.
 *
 * Asset URLs (`.md`, `.png`, `.txt`, …), external URLs, and anchor-only
 * hrefs are returned unchanged by `toBrowserHref` — they aren't HTML
 * document routes and adding a slash would break them.
 *
 * Keep these out of the public API: starter components consume hrefs the
 * framework already shaped. Authors don't (and shouldn't) call these
 * directly.
 */

/**
 * True for hrefs that point off-site — anything with a URI scheme
 * (`https:`, `mailto:`, `data:`, …) or a protocol-relative `//cdn.…`
 * prefix. Bare relative paths like `"cli"` and `"./foo"` are NOT external
 * — they resolve against the current page and the framework shouldn't
 * second-guess them.
 */
export function isAbsoluteUrl(href: string): boolean {
  return /^([a-z][a-z0-9+\-.]*:|\/\/)/i.test(href);
}

/**
 * Detect whether the final path segment looks like a file (has an
 * extension). HTML document routes don't carry an extension under
 * `build.format: "directory"`; assets like `/og/card.png`,
 * `/llms.txt`, and `/cli/index.md` do.
 *
 * Conservative: only treats short, ASCII-letter-only extensions as files,
 * so paths with dots inside a segment (`/v1.2/foo`, version slugs) still
 * count as document routes.
 */
function hasFileExtension(pathname: string): boolean {
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  const dot = lastSegment.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = lastSegment.slice(dot + 1);
  return ext.length > 0 && ext.length <= 6 && /^[a-zA-Z0-9]+$/.test(ext);
}

/** Split an href into `[pathname, suffix]` where `suffix` is the `?…#…` tail. */
function splitSuffix(href: string): [string, string] {
  const queryAt = href.indexOf("?");
  const hashAt = href.indexOf("#");
  const cutAt =
    queryAt === -1 ? hashAt : hashAt === -1 ? queryAt : Math.min(queryAt, hashAt);
  if (cutAt === -1) return [href, ""];
  return [href.slice(0, cutAt), href.slice(cutAt)];
}

/**
 * Slashless canonical form for path comparisons.
 *
 *   /cli           → /cli
 *   /cli/          → /cli
 *   /cli/?x=1#y    → /cli
 *   /              → /
 *   /guides/setup/ → /guides/setup
 *
 * Strips query and hash so callers can compare two hrefs that differ only
 * in their tail. Root stays `"/"` — that's identity, not a trailing-slash
 * artifact.
 */
export function toRouteKey(href: string): string {
  const [pathname] = splitSuffix(href);
  if (pathname.length <= 1) return pathname || "/";
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/**
 * Trailing-slash form for browser-facing hrefs to HTML document routes.
 * Preserves query and hash; root, external URLs, anchor-only hrefs, and
 * asset URLs (paths with a file extension) are returned unchanged.
 *
 *   /cli              → /cli/
 *   /cli/             → /cli/
 *   /cli#install      → /cli/#install
 *   /cli?v=1          → /cli/?v=1
 *   /                 → /
 *   /og/card.png      → /og/card.png        (asset, unchanged)
 *   /cli/index.md     → /cli/index.md       (asset, unchanged)
 *   https://x.com/a   → https://x.com/a     (external, unchanged)
 *   #anchor           → #anchor             (anchor-only, unchanged)
 */
export function toBrowserHref(href: string): string {
  // External URLs (anything with a scheme, including `//cdn.example.com`)
  // and protocol-relative URLs aren't ours to normalize.
  if (isAbsoluteUrl(href)) return href;
  // Anchor-only and query-only hrefs stay relative to the current page.
  if (href.startsWith("#") || href.startsWith("?")) return href;
  // Anything that isn't an absolute site path: don't touch it.
  if (!href.startsWith("/")) return href;

  const [pathname, suffix] = splitSuffix(href);
  if (pathname === "/") return href;
  if (hasFileExtension(pathname)) return href;
  if (pathname.endsWith("/")) return href;
  return `${pathname}/${suffix}`;
}
