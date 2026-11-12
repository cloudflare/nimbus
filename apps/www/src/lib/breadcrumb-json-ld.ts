import type { Breadcrumb, HeadElement } from "@cloudflare/nimbus-docs/types";
import { withBase } from "@cloudflare/nimbus-docs/runtime";

/**
 * The page's breadcrumb trail as a `BreadcrumbList`, for the head. Search
 * engines show it under the result and answer engines read it as the page's
 * place in the site.
 *
 * Every item but the last needs a URL. A group crumb has none when the
 * sidebar shows its index page as an "Overview" leaf, so a crumb without one
 * takes the URL of the current path's prefix at its depth (`Home / API
 * reference / Try it` on `/api-reference/try-it/` gives `/api-reference/`):
 * on this site every group folder has an index page. Nothing is emitted
 * without `site`, for a trail of one, or when the trail and the path don't
 * line up.
 */
export function breadcrumbListJsonLd(
  crumbs: Breadcrumb[],
  site: URL | undefined,
  base: string,
  currentPath: string,
): HeadElement[] {
  if (!site || crumbs.length < 2) return [];
  const segments = currentPath.split("/").filter(Boolean);
  const itemListElement = [];
  for (const [index, crumb] of crumbs.entries()) {
    const last = index === crumbs.length - 1;
    let href = crumb.href;
    if (!href && !last) {
      if (crumbs.length !== segments.length + 1) return [];
      href = `/${segments.slice(0, index).join("/")}`;
    }
    itemListElement.push({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.label,
      ...(href ? { item: new URL(pageForm(withBase(href, base)), site).href } : {}),
    });
  }
  const json = JSON.stringify({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement });
  return [{ tag: "script", attrs: { type: "application/ld+json" }, content: json.replaceAll("<", "\\u003c") }];
}

// Page URLs on this site end in a slash (the canonical form the pages emit).
function pageForm(path: string): string {
  const [pathname, hash] = path.split("#");
  const slashed = pathname.endsWith("/") || pathname.slice(pathname.lastIndexOf("/") + 1).includes(".") ? pathname : `${pathname}/`;
  return hash ? `${slashed}#${hash}` : slashed;
}
