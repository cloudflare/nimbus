/**
 * The `llms` indexes and `llms-full.txt` list pages in the sidebar's reading
 * order. A page's position is its index in a depth-first walk of the sidebar
 * tree, which is already sorted by `order`, then label, then a stable key;
 * nothing here re-sorts. Pages the sidebar doesn't show have no position and
 * follow the positioned ones, by URL.
 */

import type { SidebarItem } from "../types.js";

/** A page's place in reading order, or undefined when the sidebar doesn't show it. */
export type SidebarPosition = (page: { collection: string; id: string; url: string }) => number | undefined;

/** Each internal link's index in a depth-first walk of `items`, by normalized URL. */
export function sidebarPositions(items: readonly SidebarItem[]): Map<string, number> {
  const positions = new Map<string, number>();
  let next = 0;
  const walk = (list: readonly SidebarItem[]) => {
    for (const item of list) {
      if (item.type === "group") {
        // A group's landing page reads first, before its children.
        if (item.indexHref && !item.indexIsExternal && !positions.has(normalize(item.indexHref))) {
          positions.set(normalize(item.indexHref), next++);
        }
        walk(item.children);
      }
      else if (item.type === "link" && !positions.has(normalize(item.href))) positions.set(normalize(item.href), next++);
    }
  };
  walk(items);
  return positions;
}

/** A URL as the sidebar and the indexes both write it: no trailing slash, `/` for the root. */
export function normalize(url: string): string {
  const path = url.split(/[?#]/)[0]!;
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * Positions for a site: its docs pages from the combined sidebar tree, each
 * older docs version's pages from that version's own tree, and API pages in
 * their nav order, under the API's link in the tree when it has one, else
 * after everything else, by mount.
 */
export function llmsSidebarPosition(input: {
  /** The combined sidebar tree. */
  tree: readonly SidebarItem[];
  /** Each older docs version's own tree, by its collection (`docs-v0`). */
  versionTrees?: ReadonlyMap<string, readonly SidebarItem[]>;
  /** API collections' mounts (`/api`). */
  apiMounts: ReadonlyMap<string, string>;
  /** An API page's index in its version's nav, by collection and entry id. */
  apiNavOrder: (collection: string, id: string) => number | undefined;
}): SidebarPosition {
  const main = sidebarPositions(input.tree);
  const versions = new Map([...(input.versionTrees ?? [])].map(([collection, tree]) => [collection, sidebarPositions(tree)]));
  // An API sits at its link in the tree; one the tree doesn't link sits after
  // the whole tree, mounts in order.
  const unlinked = [...input.apiMounts].filter(([, mount]) => !main.has(normalize(mount))).map(([collection]) => collection);
  unlinked.sort((a, b) => compare(input.apiMounts.get(a)!, input.apiMounts.get(b)!));
  const apiAnchor = (collection: string): number => {
    const linked = main.get(normalize(input.apiMounts.get(collection)!));
    return linked ?? main.size + unlinked.indexOf(collection);
  };
  return ({ collection, id, url }) => {
    if (input.apiMounts.has(collection)) {
      const order = input.apiNavOrder(collection, id);
      // Nav order between the API's anchor and the next position.
      return apiAnchor(collection) + (order === undefined ? 0.999999 : (order + 1) / (order + 2) * 0.999999);
    }
    const table = versions.get(collection) ?? main;
    return table.get(normalize(url));
  };
}

/** Positioned first, by position; then the rest, by URL. */
export function compareByPosition(
  a: { position?: number; url: string },
  b: { position?: number; url: string },
): number {
  if (a.position !== undefined && b.position !== undefined && a.position !== b.position) return a.position - b.position;
  if (a.position !== undefined && b.position === undefined) return -1;
  if (a.position === undefined && b.position !== undefined) return 1;
  return compare(a.url, b.url);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
