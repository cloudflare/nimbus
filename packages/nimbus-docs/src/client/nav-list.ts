/**
 * nav-list.ts — the page list behind an on-demand API sidebar's filter
 * (`ApiNav.listHref`). Each list is fetched at most once per page load and
 * matched locally.
 */

export interface NavListRow {
  title: string;
  method?: string;
  path?: string;
  /** Root-relative, without the site base. */
  url: string;
}

const lists = new Map<string, Promise<NavListRow[]>>();

/** Start or reuse the one fetch of a list. A failed fetch is retried next time. */
export function loadNavList(url: string): Promise<NavListRow[]> {
  let list = lists.get(url);
  if (!list) {
    list = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`${url} returned ${response.status}`);
      return response.json() as Promise<NavListRow[]>;
    });
    list.catch(() => lists.delete(url));
    lists.set(url, list);
  }
  return list;
}

/** Rows whose method, path and title together contain every word of `query`. */
export function matchNavList(rows: NavListRow[], query: string): NavListRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return rows.filter((row) => {
    const text =
      `${row.method ?? ""} ${row.path ?? ""} ${row.title}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
