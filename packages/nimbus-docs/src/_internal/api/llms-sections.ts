import type { ApiNavItem } from "./api-view-types.js";

/**
 * The `llms.txt` section each API page belongs to, as the sidebar groups it:
 * the entry id of the group's index page. A page with children in the nav (a
 * product, tag or resource) indexes its own group; any other page belongs to
 * its nearest ancestor that has a page. Nav-only nodes, such as an
 * `x-tagGroups` category, have no page and are passed through. A top-level
 * page with no children belongs to none, and is placed by its URL.
 *
 * `entryId` maps a coordinate to its page's entry id, or undefined when the
 * coordinate has no page in this version.
 */
export function apiLlmsSections(
  items: readonly ApiNavItem[],
  entryId: (coordinate: string) => string | undefined,
): Map<string, string> {
  return apiLlmsPlacement(items, entryId).sections;
}

/** `apiLlmsSections`, plus each page's index in the nav's reading order. */
export function apiLlmsPlacement(
  items: readonly ApiNavItem[],
  entryId: (coordinate: string) => string | undefined,
): { sections: Map<string, string>; order: Map<string, number> } {
  const sections = new Map<string, string>();
  const order = new Map<string, number>();
  const visit = (item: ApiNavItem, ancestor: string | undefined) => {
    const id = entryId(item.coordinate);
    if (id !== undefined) {
      if (!order.has(item.coordinate)) order.set(item.coordinate, order.size);
      const section = item.children.length > 0 ? id : ancestor;
      if (section !== undefined) sections.set(item.coordinate, section);
    }
    for (const child of item.children) visit(child, id ?? ancestor);
  };
  for (const item of items) visit(item, undefined);
  return { sections, order };
}
