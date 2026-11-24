/**
 * Relative links between the pages of a content-source collection, as a
 * repository writes them for GitHub (`[Options](2-options.md#signal)`),
 * become the pages' URLs on the site. A relative `.md`/`.mdx` link to a file
 * that isn't a page of the same collection (`../readme.md`, or a file its
 * `pattern` excludes) stays as written, with one warning per file, since the
 * site doesn't publish it.
 */

import fs from "node:fs";
import path from "node:path";

import picomatch from "picomatch";

import { canonicalEntryUrl, entryRouteUrl } from "./astro-slug.js";
import { collectionMountPrefix, getMountContext } from "./collection-mount.js";
import { frontmatterSlug } from "./scan-version-frontmatter.js";
import { toDocumentHref } from "./url.js";

/** The files a collection publishes: those its pattern matches in its folder. */
export interface SourceCollection {
  /** Absolute folder the collection's glob reads. */
  folder: string;
  /** Whether the collection's pattern matches a path relative to `folder`, in posix form. */
  matches: (relativePosixPath: string) => boolean;
}

export interface SourceCollectionFolder {
  collection: string;
  /** Absolute folder the collection's glob reads. */
  folder: string;
  /** The glob pattern the collection reads `folder` with. */
  pattern: string | string[];
  /** Astro's `root`, to find where the collection is served. */
  root: URL;
}

type RegisteredCollection = SourceCollectionFolder & SourceCollection;

const REGISTRY_KEY = Symbol.for("@cloudflare/nimbus-docs/source-collections/v2");
const shared = globalThis as typeof globalThis & {
  [REGISTRY_KEY]?: { collections: Map<string, RegisteredCollection>; warned: Set<string> };
};
// Every collection that reads a content source, by project root and name,
// and the warnings already printed, shared by each copy of this module.
const { collections, warned } = (shared[REGISTRY_KEY] ??= { collections: new Map(), warned: new Set() });

/**
 * Matches paths the way Astro's glob loader selects files, which is
 * tinyglobby's reading of the pattern: a leading `!` excludes (a leading
 * `!(` is an extglob), each pattern is normalized (`docs//a.md/` is
 * `docs/a.md`), and classes are POSIX (`[!C]*.md` leaves out `CHANGELOG.md`).
 */
export function globPageMatcher(pattern: string | readonly string[]): (relativePosixPath: string) => boolean {
  const normalize = (p: string) => path.posix.normalize(p.endsWith("/") ? p.slice(0, -1) : p);
  const match: string[] = [];
  const ignore: string[] = [];
  for (const p of typeof pattern === "string" ? [pattern] : pattern) {
    if (!p) continue;
    if (p[0] !== "!" || p[1] === "(") match.push(normalize(p));
    else if (p[1] !== "!" || p[2] === "(") ignore.push(normalize(p.slice(1)));
  }
  return picomatch(match, { posix: true, ...(ignore.length > 0 ? { ignore } : {}) });
}

export function registerSourceCollectionFolder(entry: SourceCollectionFolder): void {
  const folder = path.resolve(entry.folder);
  const key = `${entry.root.href}\0${entry.collection}`;
  // Re-registering moves the entry last: a collection the config no longer
  // has stops being re-registered, so it loses ties to the current ones.
  collections.delete(key);
  collections.set(key, {
    ...entry,
    folder,
    matches: globPageMatcher(entry.pattern),
  });
}

function inside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function relativePosix(dir: string, file: string): string {
  return path.relative(dir, file).split(path.sep).join("/");
}

/**
 * The collection that publishes `file`: its folder holds the file and its
 * pattern matches it. The deepest folder wins when several do, then the
 * last of `entries`.
 */
export function sourceOwner<T extends SourceCollection>(entries: Iterable<T>, file: string): T | undefined {
  let best: T | undefined;
  for (const entry of entries) {
    if (!inside(entry.folder, file) || !entry.matches(relativePosix(entry.folder, file))) continue;
    if (!best || entry.folder.length >= best.folder.length) best = entry;
  }
  return best;
}

const PAGE_EXTENSION = /\.mdx?$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The page file a relative `.md`/`.mdx` link in `file` points at, split from
 * its `?`/`#` suffix, or `undefined` for any other link. `nimbus-docs lint`
 * uses it too, so the build and the link rule agree on which links become
 * page URLs.
 */
export function sourcePageLink(raw: string, file: string): { target: string; suffix: string } | undefined {
  if (!raw || SCHEME.test(raw) || raw.startsWith("/") || raw.startsWith("#") || raw.startsWith("<")) return undefined;
  const match = /^([^?#]*)([?#].*)?$/.exec(raw);
  const pathname = match?.[1] ?? raw;
  if (!PAGE_EXTENSION.test(pathname)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURI(pathname);
  } catch {
    decoded = pathname;
  }
  return { target: path.resolve(path.dirname(file), decoded), suffix: match?.[2] ?? "" };
}

/** Whether `target` is a page of `collection`: inside its folder, matched by its pattern, and present. */
export function isSourcePage(collection: SourceCollection, target: string): boolean {
  return (
    inside(collection.folder, target) &&
    collection.matches(relativePosix(collection.folder, target)) &&
    PAGE_EXTENSION.test(target) &&
    fs.existsSync(target)
  );
}

function pageUrl(owner: RegisteredCollection, target: string): string | undefined {
  if (!isSourcePage(owner, target)) return undefined;
  const prefix = collectionMountPrefix(owner.collection, getMountContext(owner.root));
  let slug: string | undefined;
  try {
    slug = frontmatterSlug(fs.readFileSync(target, "utf8").slice(0, 4096));
  } catch {
    slug = undefined;
  }
  if (slug !== undefined) return toDocumentHref(entryRouteUrl(prefix, slug));
  const id = relativePosix(owner.folder, target).replace(PAGE_EXTENSION, "");
  return toDocumentHref(canonicalEntryUrl(prefix, id));
}

/**
 * Rewrite relative page links in `source` (Markdown or MDX) read from
 * `filePath`. Links inside fenced code are left alone. Returns `source`
 * unchanged for a file that no source collection reads.
 */
export function rewriteSourceLinks(source: string, filePath: string | undefined): string {
  if (!filePath || collections.size === 0) return source;
  const file = path.resolve(filePath);
  const owner = sourceOwner(collections.values(), file);
  if (!owner) return source;
  // Links the site doesn't publish: files the pattern leaves out, and the rest.
  const excluded = new Set<string>();
  const unresolved = new Set<string>();
  const rewrite = (raw: string): string => {
    const link = sourcePageLink(raw, file);
    if (!link) return raw;
    const { suffix } = link;
    const url = pageUrl(owner, link.target);
    if (!url) {
      (inside(owner.folder, link.target) && fs.existsSync(link.target) ? excluded : unresolved).add(raw);
      return raw;
    }
    return `${url}${suffix.startsWith("?") ? suffix.replace(/^\?[^#]*/, "") : suffix}`;
  };

  let fence: string | null = null;
  const out = source.split("\n").map((line) => {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]!;
      else if (fenceMatch[1]!.startsWith(fence[0]!) && fenceMatch[1]!.length >= fence.length) fence = null;
      return line;
    }
    if (fence !== null) return line;
    return line
      .replace(/(\]\()(\s*)([^)\s]+)((?:\s+"[^"]*")?\s*\))/g, (_m, open: string, space: string, target: string, close: string) =>
        `${open}${space}${rewrite(target)}${close}`,
      )
      .replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/, (_m, head: string, target: string) => `${head}${rewrite(target)}`)
      .replace(/(\bhref=")([^"]+)(")/g, (_m, open: string, target: string, close: string) => `${open}${rewrite(target)}${close}`);
  });
  const count = excluded.size + unresolved.size;
  if (count > 0) {
    const key = `${file}\0${[...excluded, ...unresolved].join("\0")}`;
    if (!warned.has(key)) {
      warned.add(key);
      const list = (links: Set<string>) => [...links].map((l) => `"${l}"`).join(", ");
      const clauses = [
        ...(excluded.size ? [`${list(excluded)}, which the collection's pattern doesn't publish`] : []),
        ...(unresolved.size ? [`${list(unresolved)}, which isn't a page of this collection`] : []),
      ];
      console.warn(
        `[nimbus] ${owner.collection}: ${path.basename(file)} links to ${clauses.join(", and to ")}; ` +
          `the link${count > 1 ? "s stay" : " stays"} as written.`,
      );
    }
  }
  return out.join("\n");
}
