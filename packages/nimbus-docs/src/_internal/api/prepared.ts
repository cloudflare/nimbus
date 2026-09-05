import type { ApiNav, ApiNavItem, ApiPageProps } from "./api-view-types.js";

export const preparedApiVersion = 2;

export interface PreparedApiNav {
  version: typeof preparedApiVersion;
  nav: ApiNav;
  paths: Record<string, string[]>;
}

export interface PreparedApiPage {
  version: typeof preparedApiVersion;
  page: ApiPageProps;
  navEntryId: string;
  nav?: PreparedApiNav;
}

export function prepareApiNav(nav: ApiNav): PreparedApiNav {
  const paths: Record<string, string[]> = Object.create(null);
  const visit = (item: ApiNavItem, parentPath: string[]) => {
    const path = [...parentPath, item.coordinate];
    paths[item.coordinate] = path;
    for (const child of item.children) visit(child, path);
  };
  for (const item of nav.items) visit(item, []);
  return { version: preparedApiVersion, nav, paths };
}

export function activatePreparedApiNav(
  prepared: PreparedApiNav,
  coordinate: string,
): ApiNav {
  const path = prepared.paths[coordinate];
  if (!path) return prepared.nav;
  const onPath = new Set(path);
  const overlay = (item: ApiNavItem): ApiNavItem => {
    if (!onPath.has(item.coordinate)) return item;
    const next = { ...item, children: item.children.map(overlay) };
    if (item.coordinate === coordinate) next.active = true;
    else next.expanded = true;
    return next;
  };
  return { ...prepared.nav, items: prepared.nav.items.map(overlay) };
}

export function isPreparedApiPage(value: unknown): value is PreparedApiPage {
  if (!value || typeof value !== "object") return false;
  const prepared = value as Partial<PreparedApiPage>;
  if (
    prepared.version === preparedApiVersion &&
    typeof prepared.navEntryId === "string" &&
    !!prepared.page &&
    typeof prepared.page === "object"
  ) {
    const page = prepared.page as ApiPageProps;
    if (page.kind !== "operation") return true;
    if (
      !Array.isArray(page.samples) ||
      page.samples.some(
        (sample) =>
          !sample ||
          typeof sample !== "object" ||
          typeof sample.highlightedHtml !== "string" ||
          sample.highlightedHtml.length === 0,
      )
    ) {
      return false;
    }
    if (
      !Array.isArray(page.responses) ||
      page.responses.some(
        (response) =>
          !response ||
          typeof response !== "object" ||
          (response.example !== undefined &&
            (!response.example ||
              typeof response.example !== "object" ||
              typeof response.example.highlightedHtml !== "string" ||
              response.example.highlightedHtml.length === 0)),
      )
    ) {
      return false;
    }
    if (page.additionalBodies === undefined) return true;
    return (
      Array.isArray(page.additionalBodies) &&
      !page.additionalBodies.some(
        (body) =>
          !body ||
          typeof body !== "object" ||
          (body.example !== undefined &&
            (!body.example ||
              typeof body.example !== "object" ||
              typeof body.example.highlightedHtml !== "string" ||
              body.example.highlightedHtml.length === 0)),
      )
    );
  }
  return false;
}

export function isPreparedApiNav(value: unknown): value is PreparedApiNav {
  if (!value || typeof value !== "object") return false;
  const prepared = value as Partial<PreparedApiNav>;
  return (
    prepared.version === preparedApiVersion &&
    !!prepared.nav &&
    typeof prepared.nav === "object" &&
    !!prepared.paths &&
    typeof prepared.paths === "object"
  );
}
