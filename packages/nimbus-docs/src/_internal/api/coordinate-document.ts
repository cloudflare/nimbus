/**
 * One version's coordinates as a compact document, and the index that resolves
 * citations against a set of them.
 *
 * The same document is the file a site publishes, the copy a citing site
 * saves, and what a build holds in memory. Nothing flattens it into a
 * coordinate → URL table: a large API has over a hundred thousand coordinates
 * per version, and a build resolves a handful.
 *
 * A document is version-neutral. It holds slugs and anchors, never URLs: where
 * a version's pages mount changes when another version becomes the default, so
 * routing travels beside the document (`CoordinateRoute`), not inside it.
 */

import { createHash } from "node:crypto";

import type {
  CoordinateDocument,
  CoordinateDocumentPage,
  CoordinateMarker,
} from "../../types.js";
import { isSafeCitationPath, type CitationIndex } from "./citations.js";

export type { CoordinateDocument, CoordinateDocumentPage, CoordinateMarker };

/** Where one version's pages are served today. */
export interface CoordinateRoute {
  /** The path the version's pages mount under, without a trailing slash. */
  path: string;
  /** The version's query string (`?version=v1`), or empty. */
  query: string;
  /** An absolute origin for a remote reference, or empty. */
  origin?: string;
}

/**
 * Pack a version's targets. Each page writes its own coordinate once; a
 * coordinate that extends it stores only what follows, as a literal string.
 * Coordinates are opaque, so the suffix is never split or interpreted: a
 * property named `b.x` stays `.b.x`. Whatever doesn't extend its page's
 * coordinate goes in `other`, whole.
 */
export function createCoordinateDocument(
  targets: ReadonlyArray<{ coordinate: string; slug: string; anchor?: string }>,
): CoordinateDocument {
  const pages = new Map<string, { coordinate: string; entries: Record<string, CoordinateMarker> }>();
  const seen = new Set<string>();
  const rest: Array<{ coordinate: string; slug: string; anchor?: string }> = [];
  // A page's own coordinate is its first target with no anchor.
  for (const target of targets) {
    if (target.anchor !== undefined || pages.has(target.slug)) {
      rest.push(target);
      continue;
    }
    if (seen.has(target.coordinate)) continue;
    seen.add(target.coordinate);
    pages.set(target.slug, { coordinate: target.coordinate, entries: Object.create(null) });
  }
  const other: Record<string, [slug: string, marker: CoordinateMarker]> = Object.create(null);
  let others = 0;
  for (const { coordinate, slug, anchor } of rest) {
    if (seen.has(coordinate)) continue;
    seen.add(coordinate);
    const marker: CoordinateMarker = anchor === undefined ? null : anchor === coordinate ? 0 : anchor;
    const page = pages.get(slug);
    if (page && coordinate.startsWith(`${page.coordinate}.`)) {
      page.entries[coordinate.slice(page.coordinate.length)] = marker;
    } else {
      other[coordinate] = [slug, marker];
      others++;
    }
  }
  const sorted = [...pages].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    version: 3,
    pages: sorted.map(([slug, { coordinate, entries }]) => [
      slug,
      coordinate,
      Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    ]),
    ...(others > 0
      ? { other: Object.fromEntries(Object.entries(other).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) }
      : {}),
  };
}

/** The hash an index gives a document: of the exact bytes published. */
export function coordinateDocumentHash(text: string): string {
  return `sha256-${createHash("sha256").update(text).digest("base64")}`;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const marker = (value: unknown): value is CoordinateMarker =>
  value === null || value === 0 || typeof value === "string";

/** Limits on a document read from another site. */
export const MAX_DOCUMENT_PAGES = 200_000;
export const MAX_DOCUMENT_ENTRIES = 5_000_000;

/**
 * Check a document that came from outside this build. Returns the reason it is
 * unusable, or the entries it dropped. Nothing here builds a URL: `resolve`
 * checks every link it hands out.
 */
export function validateCoordinateDocument(
  value: unknown,
): { fault: string } | { dropped: string[]; duplicates: Set<string> } {
  if (!record(value) || value.version !== 3 || !Array.isArray(value.pages)) {
    return { fault: "expected a version 3 coordinate document with pages" };
  }
  if (value.pages.length > MAX_DOCUMENT_PAGES) return { fault: "too many pages" };
  const dropped: string[] = [];
  // A coordinate two entries claim answers for neither, as in earlier formats.
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const claim = (coordinate: string) => {
    if (!seen.has(coordinate)) return void seen.add(coordinate);
    if (!duplicates.has(coordinate)) dropped.push(`dropped duplicate coordinate ${JSON.stringify(coordinate)}`);
    duplicates.add(coordinate);
  };
  let entries = 0;
  for (const page of value.pages) {
    if (
      !Array.isArray(page) || page.length !== 3 ||
      typeof page[0] !== "string" || typeof page[1] !== "string" || !record(page[2])
    ) {
      return { fault: "invalid page entry" };
    }
    const [, coordinate, fields] = page as CoordinateDocumentPage;
    claim(coordinate);
    for (const [suffix, value] of Object.entries(fields)) {
      if (++entries > MAX_DOCUMENT_ENTRIES) return { fault: "too many coordinates" };
      if (!suffix.startsWith(".") || !marker(value)) return { fault: "invalid coordinate entry" };
      claim(coordinate + suffix);
    }
  }
  if (value.other !== undefined) {
    if (!record(value.other)) return { fault: "invalid other entries" };
    for (const [coordinate, entry] of Object.entries(value.other)) {
      if (++entries > MAX_DOCUMENT_ENTRIES) return { fault: "too many coordinates" };
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !marker(entry[1])) {
        return { fault: "invalid other entry" };
      }
      claim(coordinate);
    }
  }
  return { dropped, duplicates };
}

/** A document ready to answer lookups: pages by their coordinate. */
class LoadedDocument {
  /** Pages by their own coordinate. A build's own document never repeats one;
   *  a document from elsewhere can, and each page's entries still count. */
  private readonly pages = new Map<string, CoordinateDocumentPage[]>();

  constructor(
    private readonly document: CoordinateDocument,
    /** Coordinates the document lists twice; they resolve to nothing. */
    private readonly blocked?: ReadonlySet<string>,
  ) {
    for (const page of document.pages) {
      const same = this.pages.get(page[1]);
      if (same) same.push(page);
      else this.pages.set(page[1], [page]);
    }
  }

  /** The slug and anchor of a coordinate, or undefined. No anchor: the page itself. */
  find(coordinate: string): { slug: string; anchor: string | undefined } | undefined {
    if (this.blocked?.has(coordinate)) return undefined;
    const own = this.pages.get(coordinate);
    if (own) return { slug: own[0]![0], anchor: undefined };
    // The owning page's coordinate is a prefix that ends before a ".". Several
    // pages can match (`a` and `a.b`); only one lists the rest as an entry.
    for (let dot = coordinate.lastIndexOf("."); dot > 0; dot = coordinate.lastIndexOf(".", dot - 1)) {
      const pages = this.pages.get(coordinate.slice(0, dot));
      if (!pages) continue;
      const suffix = coordinate.slice(dot);
      for (const page of pages) {
        if (Object.hasOwn(page[2], suffix)) return { slug: page[0], anchor: anchorOf(page[2][suffix]!, coordinate) };
      }
    }
    const other = this.document.other;
    if (other && Object.hasOwn(other, coordinate)) {
      const [slug, marker] = other[coordinate]!;
      return { slug, anchor: anchorOf(marker, coordinate) };
    }
    return undefined;
  }

  *coordinates(): Iterable<string> {
    const blocked = this.blocked;
    for (const [coordinate, pages] of this.pages) {
      if (!blocked?.has(coordinate)) yield coordinate;
      for (const [, , entries] of pages) {
        for (const suffix of Object.keys(entries)) if (!blocked?.has(coordinate + suffix)) yield coordinate + suffix;
      }
    }
    for (const coordinate of Object.keys(this.document.other ?? {})) if (!blocked?.has(coordinate)) yield coordinate;
  }

  get size(): number {
    let n = 0;
    for (const _ of this.coordinates()) n++;
    return n;
  }
}

function anchorOf(marker: CoordinateMarker, coordinate: string): string | undefined {
  return marker === null ? undefined : marker === 0 ? coordinate : marker;
}

function urlFor(route: CoordinateRoute, slug: string, anchor: string | undefined): string | undefined {
  const path = slug === "" ? route.path : `${route.path}/${slug}`;
  const url = `${path || "/"}${route.query}${anchor === undefined ? "" : `#${anchor}`}`;
  return isSafeCitationPath(url) ? `${route.origin ?? ""}${url}` : undefined;
}

interface Scope {
  route: CoordinateRoute;
  /** The document, or how to read it. A reader's document is never kept with others. */
  source: CoordinateDocument | (() => CoordinateDocument);
  /** A version read on demand stays out of iteration and of what a build bundles. */
  historical: boolean;
  /** Identifies the document's content, for `digest`. */
  hash: string;
  /** Coordinates a document from elsewhere lists twice. */
  blocked?: ReadonlySet<string>;
}

/** What `virtual:nimbus/coordinates` carries: the documents, not a table. */
export interface CoordinateIndexPayload {
  scopes: Array<{ scope: string; route: CoordinateRoute; document: number; hash: string; blocked?: string[] }>;
  /** Each document once, as JSON text: the default version is two scopes over one document. */
  documents: string[];
}

/**
 * Resolves `collection:coordinate` and `collection@version:coordinate` against
 * the documents it holds. A `ReadonlyMap` for the code that reads the index as
 * one, with every lookup walking the compact form.
 */
export class CoordinateIndex implements CitationIndex {
  private readonly scopes = new Map<string, Scope>();
  private readonly loaded = new Map<CoordinateDocument, LoadedDocument>();
  /** The one on-demand document kept, so a build can't retain every old version. */
  private demand: { scope: string; document: LoadedDocument } | undefined;
  private base = "";

  /** Register a scope: `collection`, or `collection@version`. */
  add(scope: string, entry: Scope): void {
    this.scopes.set(scope, entry);
  }

  private document(name: string, scope: Scope): LoadedDocument {
    if (typeof scope.source === "function") {
      if (this.demand?.scope !== name) this.demand = { scope: name, document: new LoadedDocument(scope.source()) };
      return this.demand.document;
    }
    let loaded = this.loaded.get(scope.source);
    if (!loaded) this.loaded.set(scope.source, (loaded = new LoadedDocument(scope.source, scope.blocked)));
    return loaded;
  }

  private split(key: string): { name: string; scope: Scope; coordinate: string } | undefined {
    const colon = key.indexOf(":");
    if (colon < 0) return undefined;
    const name = key.slice(0, colon);
    const scope = this.scopes.get(name);
    return scope ? { name, scope, coordinate: key.slice(colon + 1) } : undefined;
  }

  get(key: string): string | undefined {
    const found = this.split(key);
    if (!found) return undefined;
    const target = this.document(found.name, found.scope).find(found.coordinate);
    if (!target) return undefined;
    const url = urlFor(found.scope.route, target.slug, target.anchor);
    return url === undefined ? undefined : this.base && !found.scope.route.origin ? this.base + url : url;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** True when any scope of the collection is registered, whatever it holds. */
  hasCollection(collection: string): boolean {
    for (const name of this.scopes.keys()) {
      if (name === collection || name.startsWith(`${collection}@`)) return true;
    }
    return false;
  }

  /** Every key of one key's scope: the candidates for a "did you mean". */
  *candidates(key: string): Iterable<string> {
    const found = this.split(key);
    if (!found) return;
    for (const coordinate of this.document(found.name, found.scope).coordinates()) yield `${found.name}:${coordinate}`;
  }

  keysForVersion(scope: string): Iterable<string> {
    return this.candidates(`${scope}:`);
  }

  /** Changes when any document or route does. */
  get digest(): string {
    return [...this.scopes]
      .map(([name, { hash, route }]) => `${name}\n${hash}\n${route.origin ?? ""}${route.path}${route.query}`)
      .sort()
      .join("\n") + `\n${this.base}`;
  }

  /** The same index with `base` in front of every same-site URL. */
  withBase(base: string): CoordinateIndex {
    const based = new CoordinateIndex();
    for (const [name, scope] of this.scopes) based.scopes.set(name, scope);
    based.base = base.replace(/\/$/, "");
    return based;
  }

  /** Everything but the versions read on demand, for the build's own module. */
  toPayload(): CoordinateIndexPayload {
    const documents: CoordinateDocument[] = [];
    const scopes: CoordinateIndexPayload["scopes"] = [];
    for (const [scope, { source, historical, route, hash, blocked }] of this.scopes) {
      if (historical || typeof source === "function") continue;
      let document = documents.indexOf(source);
      if (document < 0) document = documents.push(source) - 1;
      scopes.push({ scope, route, document, hash, ...(blocked?.size ? { blocked: [...blocked] } : {}) });
    }
    return { scopes, documents: documents.map((document) => JSON.stringify(document)) };
  }

  static fromPayload(payload: CoordinateIndexPayload): CoordinateIndex {
    const index = new CoordinateIndex();
    const documents = payload.documents.map((text) => JSON.parse(text) as CoordinateDocument);
    // One set per document, so the scopes that share a document share its loaded form.
    const blockedOf = new Map<number, ReadonlySet<string>>();
    for (const { scope, route, document, hash, blocked } of payload.scopes) {
      if (blocked && !blockedOf.has(document)) blockedOf.set(document, new Set(blocked));
      index.add(scope, {
        route,
        source: documents[document]!,
        historical: false,
        hash,
        ...(blockedOf.has(document) ? { blocked: blockedOf.get(document)! } : {}),
      });
    }
    return index;
  }

  // ReadonlyMap, for callers that hold the index as one. Iteration walks every
  // document held in memory, so nothing on a build's hot path uses it.

  *keys(): MapIterator<string> {
    for (const [name, scope] of this.scopes) {
      if (scope.historical || typeof scope.source === "function") continue;
      for (const coordinate of this.document(name, scope).coordinates()) yield `${name}:${coordinate}`;
    }
  }

  *entries(): MapIterator<[string, string]> {
    for (const key of this.keys()) {
      const url = this.get(key);
      if (url !== undefined) yield [key, url];
    }
  }

  *values(): MapIterator<string> {
    for (const [, url] of this.entries()) yield url;
  }

  [Symbol.iterator](): MapIterator<[string, string]> {
    return this.entries();
  }

  forEach(callback: (value: string, key: string, map: ReadonlyMap<string, string>) => void): void {
    for (const [key, url] of this.entries()) callback(url, key, this);
  }

  get size(): number {
    let n = 0;
    for (const [name, scope] of this.scopes) {
      if (scope.historical || typeof scope.source === "function") continue;
      n += this.document(name, scope).size;
    }
    return n;
  }
}
