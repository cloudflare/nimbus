import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type { LoaderContext } from "astro/loaders";

import type { NimbusMarkdownCapability } from "./markdown-loader.js";

type StoreEntry = Parameters<LoaderContext["store"]["set"]>[0];

export interface PreparedMarkdownEntry {
  id: string;
  collection: string;
  body?: string;
  data: Record<string, unknown>;
  filePath?: string;
  digest?: string | number;
  headings?: Array<{ depth: number; text: string; slug: string }>;
}

/**
 * What a collection is to Nimbus, recorded when its loader commits:
 *   - `page` — made with a page helper (`docsCollection()`,
 *     `componentsCollection()`, `withNimbusMarkdown()`); its entries are pages.
 *   - `partials` — made with `partialsCollection()`; component content.
 *   - `api` — an OpenAPI reference collection's prepared page data.
 */
export type PreparedMarkdownCollectionRole = "page" | "partials" | "api";

export interface PreparedMarkdownCollection {
  role: PreparedMarkdownCollectionRole;
  capability: PreparedMarkdownCollectionCapability;
  entries: ReadonlyMap<string, PreparedMarkdownEntry>;
  /**
   * The folder and pattern of a glob Nimbus constructed itself
   * (`docsCollection()` and friends): the duplicate-slug walk reads them.
   */
  files?: PreparedMarkdownFiles;
  /**
   * Same-id writes from two files the store couldn't both keep, in a
   * collection without `files`, still standing when the load committed.
   */
  collisions?: ReadonlyArray<PreparedMarkdownCollision>;
  /** Entry `data` fields written into each page's `.md` and `.mdx` frontmatter. */
  markdownFields?: readonly string[];
}

export interface PreparedMarkdownFiles {
  /** Absolute folder. */
  base: string;
  pattern: string | string[];
}

export interface PreparedMarkdownCollision {
  id: string;
  /** Root-relative file paths, earlier write first. */
  files: [string, string];
}

export interface PreparedMarkdownCommitDetails {
  files?: PreparedMarkdownFiles;
  markdownFields?: readonly string[];
  collisions?: ReadonlyArray<PreparedMarkdownCollision>;
}

export interface PreparedMarkdownCollectionCapability extends NimbusMarkdownCapability {
  digest: `sha256:${string}`;
}

export interface PreparedMarkdownSnapshot {
  revision: number;
  collections: ReadonlyMap<string, PreparedMarkdownCollection>;
}

interface MutableCollection {
  role: PreparedMarkdownCollectionRole;
  capability: PreparedMarkdownCollectionCapability;
  entries: Map<string, PreparedMarkdownEntry>;
  files?: PreparedMarkdownFiles;
  collisions?: ReadonlyArray<PreparedMarkdownCollision>;
  markdownFields?: readonly string[];
}

interface MutableRoot {
  session: number;
  revision: number;
  activeEpochs: Map<string, number>;
  collections: Map<string, MutableCollection>;
  locks: Map<string, Promise<void>>;
  /** Whether page headings are rendered on request instead of at load. */
  lazyHeadings: boolean;
  headingRenderers: Map<string, PreparedHeadingsRenderer>;
}

/**
 * Renders one entry's headings with the renderer of the collection that
 * loaded it, so a lazy heading matches an eager one.
 */
export type PreparedHeadingsRenderer = (entry: {
  body: string;
  filePath?: string;
}) => Promise<Array<{ depth: number; text: string; slug: string }>>;

interface RegistryState {
  version: 2;
  nextEpoch: number;
  nextSession: number;
  roots: Map<string, MutableRoot>;
}

const REGISTRY_KEY = Symbol.for(
  "@cloudflare/nimbus-docs/prepared-markdown-registry/v2",
);
const registryGlobal = globalThis as typeof globalThis & {
  [REGISTRY_KEY]?: RegistryState;
};
const existingState = registryGlobal[REGISTRY_KEY];
if (existingState && existingState.version !== 2) {
  throw new Error("Nimbus prepared Markdown registry version mismatch");
}
const state = (registryGlobal[REGISTRY_KEY] ??= {
  version: 2,
  nextEpoch: 0,
  nextSession: 0,
  roots: new Map(),
});
state.nextSession ??= 0;

function createRoot(): MutableRoot {
  return {
    session: state.nextSession,
    revision: 0,
    activeEpochs: new Map(),
    collections: new Map(),
    locks: new Map(),
    lazyHeadings: false,
    headingRenderers: new Map(),
  };
}

function copyEntry(
  collection: string,
  entry: StoreEntry,
  headings: ReadonlyMap<
    string,
    Array<{ depth: number; text: string; slug: string }>
  >,
): PreparedMarkdownEntry {
  return {
    id: entry.id,
    collection,
    body: entry.body,
    data: structuredClone(entry.data),
    filePath: entry.filePath,
    digest: entry.digest,
    headings: structuredClone(headings.get(entry.id)),
  };
}

export function preparedMarkdownCollectionCapability(
  collection: string,
  entries: Iterable<Pick<PreparedMarkdownEntry, "id" | "body" | "filePath">>,
  capability: NimbusMarkdownCapability,
): PreparedMarkdownCollectionCapability {
  const identities = [...entries]
    .map((entry) => [
      entry.id,
      // A missing body is an empty page (see the loader's commit).
      createHash("sha256").update(entry.body ?? "").digest("hex"),
      /\.md$/iu.test(entry.filePath ?? "") ? "markdown" : "mdx",
    ])
    .sort(([a], [b]) =>
      String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0,
    );
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        version: 2,
        generation: capability.generation,
        base: capability.base,
        ...(capability.urls === undefined ? {} : { urls: capability.urls }),
        collection,
        entries: identities,
      }),
    )
    .digest("hex");
  return { ...capability, digest: `sha256:${digest}` };
}

function rootState(root: string): MutableRoot {
  let current = state.roots.get(root);
  if (!current) {
    current = createRoot();
    state.roots.set(root, current);
  }
  return current;
}

export function preparedMarkdownRootKey(root: URL | string): string {
  const absolute = path.resolve(
    root instanceof URL ? fileURLToPath(root) : root,
  );
  return realpathSync.native(absolute);
}

export function beginPreparedMarkdownSession(
  root: URL | string,
  options: { lazyHeadings?: boolean } = {},
): string {
  const key = preparedMarkdownRootKey(root);
  const current = state.roots.get(key);
  const session = ++state.nextSession;
  const lazyHeadings = options.lazyHeadings === true;
  if (current) {
    current.session = session;
    current.lazyHeadings = lazyHeadings;
    current.headingRenderers.clear();
    current.activeEpochs.clear();
    if (current.collections.size > 0) current.revision += 1;
    current.collections.clear();
  } else {
    const created = createRoot();
    created.session = session;
    created.lazyHeadings = lazyHeadings;
    state.roots.set(key, created);
  }
  return key;
}

export function getPreparedMarkdownSession(root: URL | string): number {
  return state.roots.get(preparedMarkdownRootKey(root))?.session ?? 0;
}

export function isPreparedMarkdownLazyHeadings(root: string): boolean {
  return state.roots.get(root)?.lazyHeadings === true;
}

export function setPreparedHeadingsRenderer(
  root: string,
  collection: string,
  renderer: PreparedHeadingsRenderer,
): void {
  rootState(root).headingRenderers.set(collection, renderer);
}

export function getPreparedHeadingsRenderer(
  root: URL | string,
  collection: string,
): PreparedHeadingsRenderer | undefined {
  return state.roots
    .get(preparedMarkdownRootKey(root))
    ?.headingRenderers.get(collection);
}

export function getPreparedMarkdownCollectionRole(
  root: URL | string,
  collection: string,
): PreparedMarkdownCollectionRole | undefined {
  return state.roots
    .get(preparedMarkdownRootKey(root))
    ?.collections.get(collection)?.role;
}

export function beginPreparedMarkdownLoad(
  root: string,
  collection: string,
  invalidate: boolean,
): number {
  const current = rootState(root);
  const epoch = ++state.nextEpoch;
  current.activeEpochs.set(collection, epoch);
  if (invalidate && current.collections.delete(collection))
    current.revision += 1;
  return epoch;
}

export function isPreparedMarkdownLoadActive(
  root: string,
  collection: string,
  epoch: number,
): boolean {
  return state.roots.get(root)?.activeEpochs.get(collection) === epoch;
}

export function cancelPreparedMarkdownLoad(
  root: string,
  collection: string,
  epoch: number,
): void {
  const current = state.roots.get(root);
  if (current?.activeEpochs.get(collection) === epoch) {
    current.activeEpochs.delete(collection);
  }
}

export function abortPreparedMarkdownLoad(
  root: string,
  collection: string,
  epoch: number,
): void {
  const current = state.roots.get(root);
  if (current?.activeEpochs.get(collection) !== epoch) return;
  current.activeEpochs.delete(collection);
  if (current.collections.delete(collection)) current.revision += 1;
}

export function commitPreparedMarkdownCollection(
  root: string,
  collection: string,
  epoch: number,
  capability: NimbusMarkdownCapability,
  entries: Iterable<StoreEntry>,
  headings: ReadonlyMap<
    string,
    Array<{ depth: number; text: string; slug: string }>
  > = new Map(),
  role: PreparedMarkdownCollectionRole = "page",
  details: PreparedMarkdownCommitDetails = {},
): boolean {
  const current = state.roots.get(root);
  if (!current || current.activeEpochs.get(collection) !== epoch) return false;
  const sourceEntries = [...entries];
  const nextCollection: MutableCollection = {
    role,
    ...(details.files ? { files: structuredClone(details.files) } : {}),
    ...(details.collisions?.length
      ? { collisions: structuredClone(details.collisions) }
      : {}),
    // Part of the equality below: changing the list re-bakes the assets.
    ...(details.markdownFields?.length
      ? { markdownFields: [...details.markdownFields] }
      : {}),
    capability: preparedMarkdownCollectionCapability(
      collection,
      sourceEntries,
      capability,
    ),
    entries: new Map(
      sourceEntries.map((entry) => [
        entry.id,
        copyEntry(collection, entry, headings),
      ]),
    ),
  };
  if (isDeepStrictEqual(current.collections.get(collection), nextCollection)) {
    return true;
  }
  current.collections.set(collection, nextCollection);
  current.revision += 1;
  return true;
}

export function commitPreparedDataCollection(
  root: string,
  collection: string,
  epoch: number,
  entries: Iterable<StoreEntry>,
): boolean {
  const current = state.roots.get(root);
  if (!current || current.activeEpochs.get(collection) !== epoch) return false;
  const sourceEntries = [...entries];
  const nextCollection = {
    role: "api" as const,
    capability: preparedMarkdownCollectionCapability(
      collection,
      sourceEntries,
      { generation: 0, base: "" },
    ),
    entries: new Map(
      sourceEntries.map((entry) => [
        entry.id,
        copyEntry(collection, entry, new Map()),
      ]),
    ),
  };
  if (isDeepStrictEqual(current.collections.get(collection), nextCollection)) {
    return true;
  }
  current.collections.set(collection, nextCollection);
  current.revision += 1;
  return true;
}

export async function runPreparedMarkdownTransaction<T>(
  root: string,
  collection: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const current = rootState(root);
  const previous = current.locks.get(collection) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  current.locks.set(collection, settled);
  try {
    return await result;
  } finally {
    if (current.locks.get(collection) === settled) {
      current.locks.delete(collection);
    }
  }
}

export function markPreparedMarkdownRevision(root: URL | string): void {
  rootState(preparedMarkdownRootKey(root)).revision += 1;
}

export async function waitForPreparedMarkdownTransactions(
  root: URL | string,
): Promise<void> {
  const current = state.roots.get(preparedMarkdownRootKey(root));
  while (current?.locks.size) {
    await Promise.all(current.locks.values());
  }
}

/** Read one prepared entry without cloning the entire site's content graph. */
export function getPreparedMarkdownEntry(
  root: URL | string,
  collection: string,
  id: string,
): PreparedMarkdownEntry | undefined {
  const entry = state.roots
    .get(preparedMarkdownRootKey(root))
    ?.collections.get(collection)
    ?.entries.get(id);
  return entry ? structuredClone(entry) : undefined;
}

export function getPreparedMarkdownSnapshot(
  root: URL | string,
): PreparedMarkdownSnapshot | null {
  const current = state.roots.get(preparedMarkdownRootKey(root));
  if (!current) return null;
  return {
    revision: current.revision,
    collections: new Map(
      [...current.collections].map(([collection, value]) => [
        collection,
        {
          role: value.role,
          capability: structuredClone(value.capability),
          ...(value.files ? { files: structuredClone(value.files) } : {}),
          ...(value.collisions
            ? { collisions: structuredClone(value.collisions) }
            : {}),
          ...(value.markdownFields
            ? { markdownFields: [...value.markdownFields] }
            : {}),
          entries: new Map(
            [...value.entries].map(([id, entry]) => [
              id,
              structuredClone(entry),
            ]),
          ),
        },
      ]),
    ),
  };
}

const sourceFileIndexes = new WeakMap<
  MutableRoot,
  { revision: number; files: ReadonlySet<string> }
>();

function canonicalFile(file: string): string {
  try {
    return realpathSync.native(file);
  } catch {
    return file;
  }
}

/**
 * Whether `file` (absolute) is a recorded entry of a page or partials
 * collection. Synchronous, so the Sätteri callout plugin can ask it per
 * file; the index is rebuilt once per registry revision. Both sides compare
 * canonical paths, so a symlinked checkout matches its real files.
 */
export function isPreparedMarkdownSourceFile(
  root: URL | string,
  file: string,
): boolean {
  let key: string;
  try {
    key = preparedMarkdownRootKey(root);
  } catch {
    return false;
  }
  const current = state.roots.get(key);
  if (!current) return false;
  let index = sourceFileIndexes.get(current);
  if (!index || index.revision !== current.revision) {
    const files = new Set<string>();
    for (const collection of current.collections.values()) {
      if (collection.role === "api") continue;
      for (const entry of collection.entries.values()) {
        if (entry.filePath) {
          files.add(canonicalFile(path.resolve(key, entry.filePath)));
        }
      }
    }
    index = { revision: current.revision, files };
    sourceFileIndexes.set(current, index);
  }
  return index.files.has(canonicalFile(path.resolve(file)));
}

export function getPreparedMarkdownRevision(
  root: URL | string,
): number | undefined {
  return state.roots.get(preparedMarkdownRootKey(root))?.revision;
}

export function clearPreparedMarkdownRegistry(): void {
  state.roots.clear();
}
