/**
 * Root-keyed registry of the `api` entries declared in the Nimbus config.
 *
 * The integration writes the validated `config.api` entries during
 * `astro:config:setup`; a zero-argument `apiCollection()` loader reads its
 * entry here when `load()` runs. The state lives on `globalThis` behind a
 * `Symbol.for` key, so the integration (loaded through Astro's config loader)
 * and the content layer (loaded through the dev or build Vite server) share it
 * across module copies. Entries are keyed by the project's real path, so two
 * Astro projects in one process stay isolated.
 *
 * Read in `load()`, never when the collection is defined: after a dev restart
 * Astro refreshes content with the loader instances it evaluated before the
 * restart, and only a load-time read sees the edited entries.
 */

import type { ApiSpec } from "../types.js";
import { preparedMarkdownRootKey } from "./prepared-markdown-registry.js";

/** How messages refer to the file that owns the Nimbus config. */
export const NIMBUS_CONFIG_FILE = "the Nimbus config (astro.config.*)";

interface ApiCollectionRegistryState {
  version: 1;
  roots: Map<string, readonly ApiSpec[]>;
  /**
   * `apiCollection()` loads since the last registration: Astro collection key
   * (in `src/content.config.ts`) → the `collection` of the entry it indexed.
   * Keyed by the Astro key so an explicit entry under another key never counts.
   */
  loads: Map<string, Map<string, string>>;
  /** Monotonic count of `apiCollection()` loads per root. */
  loadCounts: Map<string, number>;
}

const REGISTRY_KEY = Symbol.for(
  "@cloudflare/nimbus-docs/api-collection-registry/v1",
);
const registryGlobal = globalThis as typeof globalThis & {
  [REGISTRY_KEY]?: ApiCollectionRegistryState;
};
const existingState = registryGlobal[REGISTRY_KEY];
if (existingState && existingState.version !== 1) {
  throw new Error("Nimbus API collection registry version mismatch");
}
const state = (registryGlobal[REGISTRY_KEY] ??= {
  version: 1,
  roots: new Map(),
  loads: new Map(),
  loadCounts: new Map(),
});

/** Replace the `api` entries registered for a project root. */
export function registerApiCollections(
  root: URL | string,
  api: readonly ApiSpec[] | undefined,
): void {
  const key = preparedMarkdownRootKey(root);
  state.roots.set(key, [...(api ?? [])]);
  state.loads.delete(key);
}

/**
 * Record that an `apiCollection()` loader ran under the Astro collection key,
 * indexing the `api` entry named `entryCollection`.
 */
export function noteApiCollectionLoad(
  root: URL | string,
  collectionKey: string,
  entryCollection: string,
): void {
  const key = preparedMarkdownRootKey(root);
  const loads = state.loads.get(key) ?? new Map<string, string>();
  loads.set(collectionKey, entryCollection);
  state.loads.set(key, loads);
  state.loadCounts.set(key, (state.loadCounts.get(key) ?? 0) + 1);
}

/** How many `apiCollection()` loads have started for this root, ever. */
export function apiCollectionLoadCount(root: URL | string): number {
  return state.loadCounts.get(preparedMarkdownRootKey(root)) ?? 0;
}

/** Whether an `apiCollection()` loader ran under this key since registration. */
export function hasApiCollectionLoad(
  root: URL | string,
  collectionKey: string,
): boolean {
  return (
    state.loads.get(preparedMarkdownRootKey(root))?.get(collectionKey) !== undefined
  );
}

/** The Astro key whose `apiCollection()` loader indexed the entry `collection`, if any. */
function keyIndexingEntry(root: URL | string, collection: string): string | undefined {
  for (const [key, entry] of state.loads.get(preparedMarkdownRootKey(root)) ?? []) {
    if (entry === collection) return key;
  }
  return undefined;
}

/** `undefined` when the Nimbus integration has not configured this root. */
export function getRegisteredApiCollections(
  root: URL | string,
): readonly ApiSpec[] | undefined {
  return state.roots.get(preparedMarkdownRootKey(root));
}

/**
 * The `api` entry for `collection`, or a pointed error naming both files when
 * the integration never ran or the Nimbus config has no matching entry.
 */
export function resolveRegisteredApiCollection(
  root: URL | string,
  collection: string,
): ApiSpec {
  const entries = getRegisteredApiCollections(root);
  if (!entries) {
    throw new Error(
      `nimbus-docs api: src/content.config.ts registers "${collection}" with apiCollection(), which reads ` +
        `its entry from ${NIMBUS_CONFIG_FILE}, but the Nimbus integration has not run for this project. ` +
        `Add the Nimbus integration to your Astro config, or pass the entry explicitly: ` +
        `apiCollection({ collection: "${collection}", spec: "..." }).`,
    );
  }
  const entry = entries.find((candidate) => candidate.collection === collection);
  if (!entry) {
    throw new Error(
      unconfiguredApiCollectionMessage(
        collection,
        entries.map((candidate) => candidate.collection),
      ),
    );
  }
  return entry;
}

/**
 * The error for a zero-argument `apiCollection()` whose collection key has no
 * `api` entry. Shared by the loader and `nimbus-docs check`.
 */
export function unconfiguredApiCollectionMessage(
  collection: string,
  configured: readonly string[],
): string {
  return (
    `nimbus-docs api: src/content.config.ts registers "${collection}" with apiCollection(), ` +
    `but ${NIMBUS_CONFIG_FILE} has no \`api\` entry for it. ` +
    `Configured api collections: ${formatCollections(configured)}. ` +
    `Add { collection: "${collection}", spec: "..." } to \`api\` in the Nimbus config, ` +
    `or rename the collection key in src/content.config.ts to match an entry.`
  );
}

/**
 * The error for an `api` entry that no content collection indexed. Shared by
 * the build (after content sync), the dev bake step, and `nimbus-docs check`.
 */
export function missingApiCollectionMessage(collection: string): string {
  return (
    `nimbus-docs api: ${NIMBUS_CONFIG_FILE} declares the API collection "${collection}" in \`api\`, ` +
    `but src/content.config.ts registers no collection that indexes it. ` +
    `Add ${collectionKey(collection)}: defineCollection(apiCollection()) to the collections in src/content.config.ts.`
  );
}

/**
 * The error for an `api` entry whose collection key is registered with a
 * loader other than `apiCollection()`. Shared by the build and `nimbus-docs check`.
 */
export function nonApiCollectionMessage(collection: string): string {
  return (
    `nimbus-docs api: ${NIMBUS_CONFIG_FILE} declares the API collection "${collection}" in \`api\`, ` +
    `but src/content.config.ts registers ${collectionKey(collection)} with a loader other than apiCollection(). ` +
    `Register it as ${collectionKey(collection)}: defineCollection(apiCollection()), ` +
    `or rename the \`api\` entry or the collection key so they don't collide.`
  );
}

/**
 * The error for an `api` entry that `apiCollection({ collection, … })` indexes
 * under a different collection key.
 */
export function misplacedApiCollectionMessage(
  collection: string,
  registeredKey: string,
): string {
  return (
    `nimbus-docs api: ${NIMBUS_CONFIG_FILE} declares the API collection "${collection}" in \`api\`, ` +
    `but src/content.config.ts registers it under the key ${collectionKey(registeredKey)}. ` +
    `Register it as ${collectionKey(collection)}: defineCollection(apiCollection()).`
  );
}

/** An object key for `collection`: bare when it's an identifier, quoted otherwise. */
export function collectionKey(collection: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(collection)
    ? collection
    : JSON.stringify(collection);
}

export function formatCollections(collections: readonly string[]): string {
  return collections.length > 0
    ? collections.map((collection) => `"${collection}"`).join(", ")
    : "none";
}

/**
 * Why the `api` entry `collection` wasn't indexed after content sync, or
 * `null` when it was. Requires both an `apiCollection()` load under the same
 * Astro key and prepared entries for it: a prepared collection of that name
 * from another loader, or an explicit entry under another key, doesn't count.
 */
export function apiCollectionIndexError(
  root: URL | string,
  collection: string,
  prepared: boolean,
): string | null {
  const loaded = hasApiCollectionLoad(root, collection);
  if (loaded && prepared) return null;
  if (loaded) {
    return `nimbus-docs api: the API collection "${collection}" failed to index during content sync. Fix the error reported above and save again.`;
  }
  const misplacedUnder = keyIndexingEntry(root, collection);
  if (misplacedUnder !== undefined) {
    return misplacedApiCollectionMessage(collection, misplacedUnder);
  }
  return prepared
    ? nonApiCollectionMessage(collection)
    : missingApiCollectionMessage(collection);
}

export function clearApiCollectionRegistry(): void {
  state.roots.clear();
  state.loads.clear();
  state.loadCounts.clear();
}
