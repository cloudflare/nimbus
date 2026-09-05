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

export interface PreparedMarkdownCollection {
  capability: PreparedMarkdownCollectionCapability;
  entries: ReadonlyMap<string, PreparedMarkdownEntry>;
}

export interface PreparedMarkdownCollectionCapability extends NimbusMarkdownCapability {
  digest: `sha256:${string}`;
}

export interface PreparedMarkdownSnapshot {
  revision: number;
  collections: ReadonlyMap<string, PreparedMarkdownCollection>;
}

interface MutableCollection {
  capability: PreparedMarkdownCollectionCapability;
  entries: Map<string, PreparedMarkdownEntry>;
}

interface MutableRoot {
  session: number;
  revision: number;
  activeEpochs: Map<string, number>;
  collections: Map<string, MutableCollection>;
  locks: Map<string, Promise<void>>;
}

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
  entries: Iterable<Pick<PreparedMarkdownEntry, "id" | "body">>,
  capability: NimbusMarkdownCapability,
): PreparedMarkdownCollectionCapability {
  const identities = [...entries]
    .map((entry) => [
      entry.id,
      typeof entry.body === "string"
        ? createHash("sha256").update(entry.body).digest("hex")
        : null,
    ])
    .sort(([a], [b]) =>
      String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0,
    );
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        generation: capability.generation,
        base: capability.base,
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

export function beginPreparedMarkdownSession(root: URL | string): string {
  const key = preparedMarkdownRootKey(root);
  const current = state.roots.get(key);
  const session = ++state.nextSession;
  if (current) {
    current.session = session;
    current.activeEpochs.clear();
    if (current.collections.size > 0) current.revision += 1;
    current.collections.clear();
  } else {
    const created = createRoot();
    created.session = session;
    state.roots.set(key, created);
  }
  return key;
}

export function getPreparedMarkdownSession(root: URL | string): number {
  return state.roots.get(preparedMarkdownRootKey(root))?.session ?? 0;
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
): boolean {
  const current = state.roots.get(root);
  if (!current || current.activeEpochs.get(collection) !== epoch) return false;
  const sourceEntries = [...entries];
  const nextCollection = {
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
          capability: structuredClone(value.capability),
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

export function getPreparedMarkdownRevision(
  root: URL | string,
): number | undefined {
  return state.roots.get(preparedMarkdownRootKey(root))?.revision;
}

export function clearPreparedMarkdownRegistry(): void {
  state.roots.clear();
}
