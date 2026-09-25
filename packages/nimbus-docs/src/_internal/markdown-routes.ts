/**
 * Markdown route ownership, shared by the build (`astro:routes:resolved`,
 * `astro:build:done`) and the route factories in `agent-endpoints.ts`.
 *
 * Every endpoint route whose last segment is a static `*.md` / `*.mdx` file
 * is recorded in Astro's priority order. A shared route (one built with
 * `markdownRoute()` / `markdownSourceRoute()`) serves every baked asset URL
 * its own regex matches, except URLs a higher-priority recorded route also
 * matches: the site's more specific file owns those. Runtime-safe — no Node
 * imports, so the factories can use it from a prerender or Worker bundle.
 */

export type MarkdownRouteSurface = "markdown" | "source";

export interface MarkdownRouteRecord {
  pattern: string;
  entrypoint: string;
  regex: RegExp;
  /** Param names in capture-group order, without the `...` spread prefix. */
  params: string[];
  prerendered: boolean;
  /** Set when the route file calls `markdownRoute()` or `markdownSourceRoute()`. */
  shared?: MarkdownRouteSurface;
}

export interface MarkdownRouteAsset {
  url: string;
  surface: MarkdownRouteSurface;
}

export interface UnclaimedMarkdownPath {
  url: string;
  shared: MarkdownRouteRecord;
  owner: MarkdownRouteRecord;
}

export function routeParams(
  route: MarkdownRouteRecord,
  url: string,
): Record<string, string | undefined> | null {
  const match = route.regex.exec(url);
  if (!match) return null;
  return Object.fromEntries(
    route.params.map((name, index) => [name, match[index + 1] || undefined]),
  );
}

/**
 * Locate the calling factory's own route. Astro hands `getStaticPaths` only
 * the route pattern, so prefer the recorded route whose file calls this
 * factory; fall back to the single route with that pattern when the factory
 * is reached indirectly (for example re-exported from a helper module).
 */
export function findOwnMarkdownRoute(
  routes: readonly MarkdownRouteRecord[],
  routePattern: string,
  surface: MarkdownRouteSurface,
): number {
  const candidates = routes
    .map((route, index) => ({ route, index }))
    .filter(({ route }) => route.pattern === routePattern);
  const declared = candidates.filter(({ route }) => route.shared === surface);
  if (declared.length === 1) return declared[0]!.index;
  if (declared.length === 0 && candidates.length === 1) {
    return candidates[0]!.index;
  }
  const factory =
    surface === "markdown" ? "markdownRoute()" : "markdownSourceRoute()";
  if (candidates.length === 0) {
    throw new Error(
      `nimbus-docs: ${factory} is used by route ${routePattern}, but that route ` +
        "is not an endpoint whose last segment is a static .md or .mdx file name " +
        "(for example src/pages/[...slug]/index.md.ts).",
    );
  }
  throw new Error(
    `nimbus-docs: ${factory} cannot tell which file serves ${routePattern}: ` +
      `${candidates.map(({ route }) => route.entrypoint).join(", ")}. ` +
      "Keep one route file per pattern.",
  );
}

export function higherMarkdownRouteOwner(
  routes: readonly MarkdownRouteRecord[],
  index: number,
  url: string,
): MarkdownRouteRecord | undefined {
  for (let i = 0; i < index; i += 1) {
    if (routes[i]!.regex.test(url)) return routes[i];
  }
  return undefined;
}

/**
 * Asset URLs a prerendered shared route skipped because a higher-priority
 * prerendered route owns them, but which that route did not generate.
 * Without a report these pages would silently vanish while `llms.txt` still
 * links to them. Owners rendered on request serve the URL themselves.
 */
export function findUnclaimedMarkdownPaths(
  routes: readonly MarkdownRouteRecord[],
  assets: readonly MarkdownRouteAsset[],
  generated: Pick<ReadonlySet<string>, "has">,
): UnclaimedMarkdownPath[] {
  const found = new Map<string, UnclaimedMarkdownPath>();
  routes.forEach((shared, index) => {
    if (!shared.shared || !shared.prerendered) return;
    for (const asset of assets) {
      if (asset.surface !== shared.shared || found.has(asset.url)) continue;
      if (!shared.regex.test(asset.url)) continue;
      const owner = higherMarkdownRouteOwner(routes, index, asset.url);
      if (owner?.prerendered && !generated.has(asset.url)) {
        found.set(asset.url, { url: asset.url, shared, owner });
      }
    }
  });
  return [...found.values()].sort((a, b) => a.url.localeCompare(b.url));
}

export function formatUnclaimedMarkdownPaths(
  unclaimed: readonly UnclaimedMarkdownPath[],
): string {
  const byOwner = new Map<MarkdownRouteRecord, string[]>();
  for (const { owner, url } of unclaimed) {
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), url]);
  }
  const lines = [...byOwner].map(
    ([owner, urls]) =>
      `  - ${owner.entrypoint} (${owner.pattern}) matches but did not generate: ${urls.join(", ")}`,
  );
  return (
    `nimbus-docs: ${unclaimed.length} Markdown path${unclaimed.length === 1 ? "" : "s"} ` +
    "belong to a more specific route that did not generate them, so the shared " +
    "Markdown route skipped them and they were not built:\n" +
    `${lines.join("\n")}\n` +
    "Generate these paths from that route, or narrow its route pattern so the shared route serves them."
  );
}
