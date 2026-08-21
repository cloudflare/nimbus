/**
 * `@cloudflare/nimbus-docs/api` — the OpenAPI reference engine's public seam.
 *
 * A copied `registry:ui` slug sees ONLY the frozen view-model here: flat,
 * JSON-serializable page props and nav, with hrefs, anchors, and omitted-counts
 * pre-resolved (`apiSchemaVersion` = 1). The spine IR
 * (`DocsModel`/`Node`/`Facts`/`NodeKind`) never crosses this boundary; the model
 * is handed back as an opaque `ApiModel` handle whose only legal use is passing
 * it to the helpers below.
 */

import { parseOpenApi } from "../_internal/api/parse.js";
import type { DocsModel } from "../_internal/api/model.js";
import {
  projectNav,
  projectPageProps,
  pageSlugs,
  indexPages,
  type ApiModel,
  type ApiNav,
  type ApiPageProps,
  type ApiPageIndexEntry,
  type SpecSource,
} from "../_internal/api/view-model.js";

export { apiSchemaVersion } from "../_internal/api/view-model.js";
export type {
  ApiModel,
  ApiNav,
  ApiNavItem,
  ApiNodeKind,
  ApiPageProps,
  ApiOperationPage,
  ApiSchemaPage,
  ApiSectionPage,
  ApiRootPage,
  ApiFieldView,
  ApiScalarView,
  ApiUnionView,
  ApiVariant,
  ApiDiscriminatorEntry,
  ApiParamGroup,
  ApiAuthView,
  ApiCodeSampleView,
  ApiExampleView,
  ApiResponseView,
  ApiBreadcrumb,
  ApiRef,
  ApiConstraint,
  ApiPageIndexEntry,
  JsonValue,
  SpecSource,
} from "../_internal/api/view-model.js";
export { ApiBuildError } from "../_internal/api/coordinates.js";
export type { Diagnostic } from "../_internal/api/coordinates.js";
export { renderApiPageMarkdown } from "../_internal/api/markdown.js";

const modelStore = new WeakMap<object, DocsModel>();
const handleCache = new Map<string, Promise<ApiModel>>();
// Per-collection resolved-source cache, so repeated render-time `getApiModel`
// calls (one per page, across the twin + HTML routes + corpus) don't re-read
// and re-hash the whole spec file. Distinct from `handleCache` (content-keyed).
const sourceCache = new Map<string, Promise<SpecSource>>();

/** FNV-1a → base36. Keeps the cache key compact *and* content-addressed. */
function specDigest(raw: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function wrap(model: DocsModel): ApiModel {
  const handle = Object.freeze({}) as ApiModel;
  modelStore.set(handle as unknown as object, model);
  return handle;
}

function unwrap(model: ApiModel): DocsModel {
  const docs = modelStore.get(model as unknown as object);
  if (!docs) {
    throw new Error(
      "Invalid ApiModel handle — pass the value returned by buildApiModel().",
    );
  }
  return docs;
}

/**
 * Parse a spec into the opaque `ApiModel` handle. Memoised per (collection,
 * spec) so a build parses each spec once; two distinct inline specs on the same
 * collection do not alias.
 */
export async function buildApiModel(source: SpecSource): Promise<ApiModel> {
  const raw =
    typeof source.spec === "string" ? source.spec : JSON.stringify(source.spec);
  // Content-addressed: the key follows the *bytes*, not a path, so an edited
  // spec is a cache miss (dev hot-reload gets a fresh parse for free).
  const key = `${source.collection}::${specDigest(raw)}`;
  const cached = handleCache.get(key);
  if (cached) return cached;
  const promise = parseOpenApi(source).then((r) => wrap(r.model));
  handleCache.set(key, promise);
  // Never leave a rejected promise cached — a transient parse failure in dev
  // would otherwise be sticky until the server restarts.
  promise.catch(() => {
    if (handleCache.get(key) === promise) handleCache.delete(key);
  });
  return promise;
}

/**
 * Evict every cached model for one collection. The `apiCollection()` loader
 * calls this on a watched-spec change so the next `buildApiModel` reparses.
 */
export function clearApiModelCache(collection: string): void {
  const prefix = `${collection}::`;
  for (const key of [...handleCache.keys()]) {
    if (key.startsWith(prefix)) handleCache.delete(key);
  }
  // Drop the resolved-source memo too, so a watched-spec change forces a
  // fresh read on the next render, matching the loader's reparse.
  sourceCache.delete(collection);
}

/**
 * Build (or reuse) the model for a `nimbus.config.ts`-declared collection —
 * the render-side entry point a copied `/<collection>/[...slug]` route uses.
 * Reads the same `api[]` declaration the loader indexed and re-derives the
 * model from the spec (memoized per graph), so render never depends on the
 * loader's cache surviving the content-sync → render phase boundary.
 */
export async function getApiModel(collection: string): Promise<ApiModel> {
  const cachedSource = sourceCache.get(collection);
  if (cachedSource) return buildApiModel(await cachedSource);

  const { loadNimbusConfig, loadProjectRoot } = await import(
    "../_internal/runtime-config.js"
  );
  const { resolveSpecSource } = await import("../_internal/api/resolve-spec.js");
  const config = await loadNimbusConfig();
  const entry = (config.api ?? []).find((a) => a.collection === collection);
  if (!entry) {
    throw new Error(
      `nimbus-docs api: no spec registered for collection "${collection}". ` +
        `Declare it in \`nimbus.config.ts\`: api: [{ collection: "${collection}", spec: "./openapi.yaml" }].`,
    );
  }
  // Resolve against the loader's base (astroConfig.root), not process.cwd() —
  // they differ under monorepo/subpackage/`--root`/Cloudflare builds.
  const promise = loadProjectRoot().then((root) => resolveSpecSource(entry, root));
  sourceCache.set(collection, promise);
  // Never leave a rejected resolution cached — a transient read failure (an
  // editor's atomic write-then-rename) would otherwise stick until the next
  // watched-file event, mirroring the `handleCache` guard above.
  promise.catch(() => {
    if (sourceCache.get(collection) === promise) sourceCache.delete(collection);
  });
  return buildApiModel(await promise);
}

export function getApiPageProps(
  model: ApiModel,
  coordinate: string,
): ApiPageProps {
  return projectPageProps(unwrap(model), coordinate);
}

export function getApiNav(model: ApiModel, activeCoordinate?: string): ApiNav {
  return projectNav(unwrap(model), activeCoordinate);
}

export function getApiPageSlugs(
  model: ApiModel,
): Array<{ coordinate: string; slug: string }> {
  return pageSlugs(unwrap(model));
}

/** Each page's slug plus display title/description, in one pass. The loader
 * seeds the agent index from this so it never carries the model past the
 * content-sync → render boundary. */
export function getApiPageIndex(model: ApiModel): ApiPageIndexEntry[] {
  return indexPages(unwrap(model));
}
