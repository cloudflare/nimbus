import { preparedMarkdownRootKey } from "./prepared-markdown-registry.js";

// The API collections whose entry sets `bundle: false`, per project root.
const key = Symbol.for("@cloudflare/nimbus-docs/page-assets-config/v1");
const shared = globalThis as typeof globalThis & {
  [key]?: Map<string, Set<string>>;
};
const roots = (shared[key] ??= new Map());
const buildKey = Symbol.for("@cloudflare/nimbus-docs/page-assets-build/v1");
const buildShared = globalThis as typeof globalThis & {
  [buildKey]?: Set<string>;
};
const buildingRoots = (buildShared[buildKey] ??= new Set());

export function configurePageAssetCollections(
  root: URL | string,
  collections: readonly string[],
  building = false,
): void {
  const rootKey = preparedMarkdownRootKey(root);
  roots.set(rootKey, new Set(collections));
  if (building) buildingRoots.add(rootKey);
  else buildingRoots.delete(rootKey);
}

/** An `astro build` never sees its inputs change mid-process; dev does. */
export function buildsPageAssets(root: URL | string): boolean {
  return buildingRoots.has(preparedMarkdownRootKey(root));
}

export function usesPageAssets(
  root: URL | string,
  collection: string,
): boolean {
  return roots.get(preparedMarkdownRootKey(root))?.has(collection) ?? false;
}

/**
 * The API collections that set `bundle: false`. Their page data is read on
 * request, so each must render on request.
 */
const requestKey = Symbol.for(
  "@cloudflare/nimbus-docs/request-api-collections/v1",
);
const requestShared = globalThis as typeof globalThis & {
  [requestKey]?: Map<string, Set<string>>;
};
const requestRoots = (requestShared[requestKey] ??= new Map());

/** Record which API collections render on request, for the bundle-size hint. */
export function configureRequestApiCollections(
  root: URL | string,
  config: Parameters<typeof unbundledApiCollections>[0],
): void {
  requestRoots.set(
    preparedMarkdownRootKey(root),
    new Set(
      (config.api ?? [])
        .map((entry) => entry.collection)
        .filter(
          (collection) => renderingMode(config, collection) === "request",
        ),
    ),
  );
}

export function rendersApiOnRequest(
  root: URL | string,
  collection: string,
): boolean {
  return (
    requestRoots.get(preparedMarkdownRootKey(root))?.has(collection) ?? false
  );
}

function renderingMode(
  config: Parameters<typeof unbundledApiCollections>[0],
  collection: string,
): string {
  return (
    config.rendering?.collections?.[collection] ??
    config.rendering?.default ??
    "build"
  );
}

export function unbundledApiCollections(config: {
  api?: ReadonlyArray<{ collection: string; bundle?: boolean }>;
  rendering?: { default?: string; collections?: Record<string, string> };
}): string[] {
  const collections = (config.api ?? [])
    .filter((entry) => entry.bundle === false)
    .map((entry) => entry.collection);
  for (const collection of collections) {
    if (renderingMode(config, collection) !== "request") {
      throw new Error(
        `nimbus-docs: api "${collection}" sets bundle: false, which needs it rendered on request. ` +
          `Add rendering: { collections: { ${JSON.stringify(collection)}: "request" } } to the Nimbus config, or remove bundle: false.`,
      );
    }
  }
  return collections;
}
