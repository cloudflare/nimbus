import type { Breadcrumb, PrevNext, PrevNextOverrides, SidebarItem } from "../types.js";
import { findActivePath, flattenSidebar } from "./sidebar.js";
import { toBrowserHref, toRouteKey } from "./url.js";

export type { Breadcrumb, PrevNext, PrevNextOverrides };

/**
 * Resolve a crumb's label. Return a string to override the node label,
 * `null` to drop the crumb, or `undefined` to keep it. May be async.
 */
export type BreadcrumbResolveLabel = (ctx: {
  node: SidebarItem;
  slug: string;
}) => string | null | undefined | Promise<string | null | undefined>;

export interface BreadcrumbOptions {
  root?: { label: string; href: string };
  resolveLabel?: BreadcrumbResolveLabel;
}

/**
 * The in-site href a node links to, or `undefined` for a non-interactive
 * crumb (index-less groups and off-site landings).
 */
function nodeHref(node: SidebarItem): string | undefined {
  if (node.type === "link") return node.href;
  if (node.type === "external") return undefined;
  return node.indexIsExternal ? undefined : node.indexHref;
}

/**
 * Build the trail from the root crumb and per-node labels. `labels[i]`
 * pairs with `path[i]`: `null` drops the crumb, `undefined` keeps the
 * node label. Deduplicated by href (first wins); hrefless crumbs are
 * never merged.
 */
export function assembleBreadcrumbs(
  root: { label: string; href: string },
  path: SidebarItem[],
  labels: (string | null | undefined)[],
): Breadcrumb[] {
  const crumbs: Breadcrumb[] = [{ label: root.label, href: root.href }];

  path.forEach((node, i) => {
    const override = labels[i];
    if (override === null) return; // explicit drop
    const label = override ?? node.label;
    const href = nodeHref(node);
    crumbs.push(href ? { label, href } : { label });
  });

  const seen = new Set<string>();
  return crumbs.filter((c) => {
    if (c.href === undefined) return true;
    if (seen.has(c.href)) return false;
    seen.add(c.href);
    return true;
  });
}

/**
 * Build a breadcrumb trail from the active node's ancestry in the tree.
 * Synchronous; takes a pre-built tree and a synchronous `resolveLabel`.
 */
export function breadcrumbsFromTree(
  tree: SidebarItem[],
  slug: string,
  options?: { root?: { label: string; href: string }; resolveLabel?: (ctx: { node: SidebarItem; slug: string }) => string | null | undefined },
): Breadcrumb[] {
  const root = options?.root ?? { label: "Home", href: "/" };
  const path = findActivePath(tree, slug);
  const labels = path.map((node) => options?.resolveLabel?.({ node, slug }));
  return assembleBreadcrumbs(root, path, labels);
}

/**
 * Append `trail` items to a section's ancestry crumbs (a leaf with no
 * `href` is the current page) and deduplicate by href, so a trail crumb
 * that repeats an ancestry crumb's URL collapses to one (first wins). The
 * pure core of `getRouteNavigation`.
 */
export function composeRouteBreadcrumbs(
  sectionCrumbs: Breadcrumb[],
  trail: { label: string; href?: string }[],
): Breadcrumb[] {
  const combined: Breadcrumb[] = [
    ...sectionCrumbs,
    ...trail.map((t) => (t.href ? { label: t.label, href: t.href } : { label: t.label })),
  ];
  const seen = new Set<string>();
  return combined.filter((c) => {
    if (c.href === undefined) return true;
    if (seen.has(c.href)) return false;
    seen.add(c.href);
    return true;
  });
}

/**
 * URL-segment fallback for pages with no node in the tree, so a stray
 * page still gets a root-anchored trail.
 */
export function breadcrumbsFromUrl(slug: string, homeLabel = "Home"): Breadcrumb[] {
  const parts = slug.split("/").filter(Boolean);
  const crumbs: Breadcrumb[] = [{ label: homeLabel, href: "/" }];

  let path = "";
  for (const part of parts) {
    path += `/${part}`;
    crumbs.push({
      label: part.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      href: toBrowserHref(path),
    });
  }

  return crumbs;
}

type PrevNextOverride = { link?: string; label?: string };

function resolveOverride(
  override: string | PrevNextOverride | false | undefined,
  fallback: { label: string; href: string } | undefined,
  validInternalLinks?: Set<string>,
): { label: string; href: string } | undefined {
  if (override === false) return undefined;
  if (override === undefined) return fallback;
  if (typeof override === "string") {
    // String form: label-only override — keeps the sidebar neighbor's href, replaces the label
    if (!fallback) return undefined;
    return { label: override, href: fallback.href };
  }
  // Object form: merge with fallback — omitted fields inherit from sidebar neighbor
  if (override.link && !override.link.startsWith("/") && !override.link.startsWith("http")) {
    throw new Error(
      `prev/next override link "${override.link}" must be an absolute path (starting with /) or a full URL`,
    );
  }
  if (override.link?.startsWith("/") && validInternalLinks) {
    // `validInternalLinks` holds slashless route keys (from indexed
    // entries). Normalize the override's link to the same shape so
    // `/cli`, `/cli/`, and `/cli/?ref=x` all resolve.
    const targetPath = toRouteKey(override.link);
    if (!validInternalLinks.has(targetPath)) {
      throw new Error(`prev/next override link "${override.link}" does not match any existing internal docs route`);
    }
  }
  const label = override.label ?? fallback?.label;
  // Override links go straight to `<a href>`, so render in the trailing-
  // slash form static hosts serve. External `http(s)://…` URLs and asset
  // paths fall through `toBrowserHref` unchanged.
  const href = override.link ? toBrowserHref(override.link) : fallback?.href;

  // Without a sidebar neighbor, object overrides must be complete.
  if (!fallback && (label === undefined || href === undefined)) {
    throw new Error("prev/next object override requires both `label` and `link` when no sidebar neighbor exists");
  }

  if (!href) return undefined;
  return { label: label ?? "", href };
}

export function getPrevNext(
  currentPath: string,
  sidebarTree: SidebarItem[],
  overrides?: PrevNextOverrides,
  validInternalLinks?: Set<string>,
): PrevNext {
  const flat = flattenSidebar(sidebarTree);
  // Sidebar hrefs are trailing-slash browser-form; `currentPath` from
  // routes may be either form. Compare via route key so they line up.
  const currentKey = toRouteKey(currentPath);
  const index = flat.findIndex((item) => toRouteKey(item.href) === currentKey);

  const sidebarPrev = index > 0 ? { label: flat[index - 1]!.label, href: flat[index - 1]!.href } : undefined;
  const sidebarNext =
    index >= 0 && index < flat.length - 1 ? { label: flat[index + 1]!.label, href: flat[index + 1]!.href } : undefined;

  if (!overrides) {
    return { prev: sidebarPrev, next: sidebarNext };
  }

  return {
    prev: resolveOverride(overrides.prev, sidebarPrev, validInternalLinks),
    next: resolveOverride(overrides.next, sidebarNext, validInternalLinks),
  };
}
