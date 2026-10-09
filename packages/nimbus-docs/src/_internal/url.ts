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
  // The site root under a base is a page like any other: without trailing
  // slashes Astro serves `/docs`, not `/docs/`.
  if (normalized === "/" && prefix && !appendsSlash(linkPolicy())) return `${prefix}${suffix}`;
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

/**
 * A page path as Nimbus's routes know it. Under `build.format: "file"`,
 * `Astro.url.pathname` ends in `.html` (`/guides/setup.html`, `/index.html`)
 * while every route, link, and sidebar href has none. Entry IDs can't end in
 * `.html` (Astro's slugger drops the dot), so this never strips a real slug.
 */
export function withoutHtmlExtension(path: string): string {
  return path.replace(/(?:\/index)?\.html$/, "") || "/";
}

/** The Astro config that decides a document URL's trailing slash. */
export interface LinkPolicy {
  trailingSlash: "always" | "never" | "ignore";
  format: "directory" | "file" | "preserve";
}

// On globalThis: the integration, Vite, and the content layer load separate
// copies of this module in one process, and all of them build links.
const LINK_POLICY_KEY = Symbol.for("@cloudflare/nimbus-docs/link-policy");
const ASTRO_DEFAULT_POLICY: LinkPolicy = { trailingSlash: "ignore", format: "directory" };
type PolicyHost = { [LINK_POLICY_KEY]?: LinkPolicy };

/**
 * Follow Astro's URL shape in generated document hrefs. Set from Astro's config
 * by the integration (build-time work) and by the runtime config bridge (page
 * rendering), so every generated link matches the canonical URL.
 */
export function setLinkPolicy(policy: LinkPolicy): void {
  (globalThis as PolicyHost)[LINK_POLICY_KEY] = policy;
}

export function linkPolicy(): LinkPolicy {
  return (globalThis as PolicyHost)[LINK_POLICY_KEY] ?? ASTRO_DEFAULT_POLICY;
}

// Mirrors Astro's internal `shouldAppendForwardSlash(trailingSlash, build.format)`.
function appendsSlash({ trailingSlash, format }: LinkPolicy): boolean {
  if (trailingSlash === "always") return true;
  if (trailingSlash === "never") return false;
  return format === "directory";
}

/**
 * Browser-facing href for an HTML document route, with a trailing slash
 * exactly when Astro adds one: `"always"`, or `"ignore"` with the default
 * `build.format: "directory"`. Preserves query and hash; root, external URLs,
 * anchor-only hrefs, and asset URLs (paths with a file extension) are
 * returned unchanged.
 *
 *   /cli              → /cli/   (no slash: /cli)
 *   /cli/             → /cli/   (no slash: /cli)
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

  if (hasFileExtension(splitSuffix(href)[0])) return href;
  return toDocumentHref(href);
}

/**
 * `toBrowserHref` for a path known to be a page, such as an API route, even
 * when its last segment looks like a file (`/api/reports.list`).
 */
export function toDocumentHref(href: string): string {
  if (isAbsoluteUrl(href) || !href.startsWith("/")) return href;
  const [pathname, suffix] = splitSuffix(href);
  if (pathname === "/") return href;
  if (!appendsSlash(linkPolicy())) {
    let end = pathname.length;
    while (end > 1 && pathname[end - 1] === "/") end--;
    return `${pathname.slice(0, end)}${suffix}`;
  }
  if (pathname.endsWith("/")) return href;
  return `${pathname}/${suffix}`;
}
