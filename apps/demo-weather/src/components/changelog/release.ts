import type { CollectionEntry } from "astro:content";

type Entry = CollectionEntry<"changelog">;

/** Anchor for an entry: its version (`v2-12-0`), else its id. */
export const anchor = (entry: Entry) =>
  entry.data.version ? `v${entry.data.version.replaceAll(".", "-")}` : entry.id;

export const dateLabel = (date: Date, month: "short" | "long" = "short") =>
  date.toLocaleDateString("en-US", { month, day: "numeric", year: "numeric", timeZone: "UTC" });

/** Newest first, grouped by year. */
export function byYear(entries: Entry[]): Array<[number, Entry[]]> {
  const sorted = [...entries].sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
  const years = new Map<number, Entry[]>();
  for (const e of sorted) {
    const y = e.data.date.getUTCFullYear();
    years.set(y, [...(years.get(y) ?? []), e]);
  }
  return [...years];
}

/** Releases per changelog page. */
export const PAGE_SIZE = 10;

/** Newest first, split into pages of `PAGE_SIZE`. */
export function paginate(entries: Entry[]): Entry[][] {
  const sorted = [...entries].sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
  const pages: Entry[][] = [];
  for (let i = 0; i < sorted.length; i += PAGE_SIZE) pages.push(sorted.slice(i, i + PAGE_SIZE));
  return pages.length > 0 ? pages : [[]];
}

/** Page 1 is the changelog root; the rest live under /changelog/page/<n>/. */
export const pageHref = (page: number) => (page === 1 ? "/changelog/" : `/changelog/page/${page}/`);

const releaseLabel = (entry: Entry) => entry.data.version ?? dateLabel(entry.data.date);

/** The releases a page holds, newest to oldest: "2.12.0 – 2.3.0". */
export function rangeLabel(list: Entry[]): string {
  if (list.length === 0) return "";
  const first = releaseLabel(list[0]);
  const last = releaseLabel(list[list.length - 1]);
  return first === last ? first : `${first} – ${last}`;
}

/** The id of a release section on the release's own page: "New" → "new". */
export const releaseSectionId = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** A release's sections, for its page's "On this page", read from its source. */
export function releaseSections(body: string | undefined): Array<{ depth: 2; text: string; slug: string }> {
  return [...(body ?? "").matchAll(/<ReleaseSection\s+title="([^"]+)"/g)].map((m) => ({ depth: 2, text: m[1], slug: releaseSectionId(m[1]) }));
}
