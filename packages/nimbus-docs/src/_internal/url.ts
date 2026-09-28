/**
 * Internal URL helpers — one shape for matching, one shape for rendering.
 *
 * Generated hrefs must match the URL Astro serves for `trailingSlash`, or
 * every sidebar click costs a redirect (or a 404 in `preview`). Href shape
 * splits into two forms:
 *
 *   - `toRouteKey(href)` — slashless canonical form. Used wherever the
 *     framework compares paths for identity (active sidebar state,
 *     prev/next lookup, validation against the indexed route set).
 *
 *   - `toBrowserHref(href)` — what we emit into `<a href>` / `<link>` for
 *     HTML document routes, shaped by Astro's `trailingSlash`.
 *
 * Asset URLs (`.md`, `.png`, `.txt`, …), external URLs, and anchor-only
 * hrefs are returned unchanged by `toBrowserHref` — they aren't HTML
 * document routes and a slash would break them.
 *
 * `withBase` is public because starter-owned layouts and routes must apply the
 * same sub-path rule as framework-owned metadata. Site-relative inputs are
 * logical routes and must reach this helper exactly once.
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
 * Prefix a logical site-relative path with Astro's configured base path.
 * External URLs pass through.
 *
 * Pass `import.meta.env.BASE_URL` as `base` from an Astro component or route.
 */
export function withBase(path: string, base: string): string {
  if (isAbsoluteUrl(path)) return path;
  if (path.startsWith("#") || path.startsWith("?")) return path;
  // Trim trailing slashes with a linear scan rather than a `/\/+$/` regex,
  // which CodeQL flags as polynomial backtracking on slash-heavy input.
  let end = base.length;
  while (end > 0 && base[end - 1] === "/") end--;
  const prefix = base.slice(0, end);
  const [pathname, suffix] = splitSuffix(path);
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${prefix}${normalized}${suffix}`;
}

export function stripBase(path: string, base: string): string {
  let end = base.length;
  while (end > 0 && base[end - 1] === "/") end--;
  const prefix = base.slice(0, end);
  if (!prefix) return path;
  const [pathname, suffix] = splitSuffix(path);
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return path;
  return `${pathname.slice(prefix.length) || "/"}${suffix}`;
}

/**
 * Detect whether the final path segment looks like a file (has an
 * extension). HTML document routes don't carry an extension under
 * `build.format: "directory"`; assets like `/og/card.png`,
 * `/llms.txt`, and `/cli/index.md` do.
 *
 * Conservative: only treats short ASCII extensions containing a letter as
 * files (`.png`, `.mp4`, `.woff2`), so dotted version slugs and numeric
 * segments (`/v1.2`, `/v1.2/foo`, `/1.1.1.1`) still count as document routes.
 */
function hasFileExtension(pathname: string): boolean {
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  const dot = lastSegment.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = lastSegment.slice(dot + 1);
  return ext.length <= 6 && /^[a-zA-Z0-9]+$/.test(ext) && /[a-zA-Z]/.test(ext);
}

/** `decodeURIComponent` that returns its input untouched on malformed sequences. */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
 * artifact. Percent-encoded segments are decoded so an encoded request path
 * (`/%E6%8C%87%E5%8D%97/`) matches its decoded tree href (`/指南/`).
 */
export function toRouteKey(href: string): string {
  const [pathname] = splitSuffix(href);
  const decoded = safeDecode(pathname);
  if (decoded.length <= 1) return decoded || "/";
  return decoded.endsWith("/") ? decoded.slice(0, -1) : decoded;
}

export type TrailingSlash = "always" | "never" | "ignore";

let trailingSlash: TrailingSlash = "ignore";

/**
 * Follow Astro's `trailingSlash` in generated document hrefs. Set from Astro's
 * config by the integration (build-time work) and by the runtime config bridge
 * (page rendering), so every generated link matches the canonical URL.
 */
export function setTrailingSlash(value: TrailingSlash): void {
  trailingSlash = value;
}

/**
 * Browser-facing href for an HTML document route, shaped by Astro's
 * `trailingSlash`: `"never"` drops the trailing slash, `"always"` and
 * `"ignore"` add it. Preserves query and hash; root, external URLs,
 * anchor-only hrefs, and asset URLs (paths with a file extension) are
 * returned unchanged.
 *
 *   /cli              → /cli/   ("never": /cli)
 *   /cli/             → /cli/   ("never": /cli)
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
  if (trailingSlash === "never") {
    let end = pathname.length;
    while (end > 1 && pathname[end - 1] === "/") end--;
    return `${pathname.slice(0, end)}${suffix}`;
  }
  if (pathname.endsWith("/")) return href;
  return `${pathname}/${suffix}`;
}
