import type { PageSearchScope } from "../types.js";

/**
 * The current page's search scope, as a layout wrote it on `<body>`
 * (`getPageSearchScope()` on the server). Read on every search, since a
 * search module outlives client-side navigation. `undefined` on a page whose
 * layout writes no scope.
 */
export function pageSearchScope(root: Document = document): PageSearchScope | undefined {
  const body = root.body;
  const version = body?.getAttribute("data-nb-search-version");
  if (!body || !version) return undefined;
  return {
    version,
    deprecated: body.getAttribute("data-nb-search-deprecated") === "true",
  };
}
