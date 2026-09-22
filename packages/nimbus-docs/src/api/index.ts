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

import { createHash } from "node:crypto";

import { parseOpenApi } from "../_internal/api/parse.js";
import type { DocsModel } from "../_internal/api/model.js";
import {
  projectNav,
  projectPageProps,
  pageSlugs,
  routeProvenance,
  fieldCitations,
  indexPages,
  type ApiModel,
  type ApiNav,
  type ApiPageProps,
  type ApiPageIndexEntry,
  type ApiRouteProvenance,
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
  ApiTypeShape,
  ApiScalarView,
  ApiUnionView,
  ApiVariant,
  ApiDiscriminatorEntry,
  ApiParamGroup,
  ApiAuthView,
  ApiCodeSampleView,
  ApiExampleView,
  ApiRequestExampleView,
  ApiRequestBodyView,
  ApiResponseView,
  ApiRouteProvenance,
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
// Per-version configured-model cache, so repeated render-time `getApiModel`
// calls across Markdown and HTML routes neither re-read nor re-hash the spec.
const configuredModelCache = new Map<string, Promise<ApiModel>>();

/** SHA-256 → base64url. Collision-resistant *and* content-addressed. */
function specDigest(raw: string): string {
  return createHash("sha256").update(raw).digest("base64url");
}

/** Deterministic JSON with object keys sorted at every depth, so a route policy
 *  keys the model cache by *value*, not by authoring key order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
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
  // spec is a cache miss (dev hot-reload gets a fresh parse for free). The mount
  // path, `requireOperationId`, and the route policy are keyed too, since each
  // changes the output — two versions with identical spec bytes but different
  // policies must never alias.
  const key = `${source.collection}::${source.mountPath ?? ""}::${
    source.requireOperationId ? "strictOpId" : ""
  }::${stableStringify(source.routes)}::${specDigest(raw)}`;
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
  // Every version of a family shares the namespace (`collection`), so the
  // `${collection}::` handle prefix already spans them all.
  const prefix = `${collection}::`;
  for (const key of [...handleCache.keys()]) {
    if (key.startsWith(prefix)) handleCache.delete(key);
  }
  // Drop the configured model memos too, so a watched-spec change forces a
  // fresh read on the next render. Keys are per-version (`collection`
  // or `collection@<version>`), so evict the family name and every version.
  const unversionedPrefix = `${collection}::`;
  const versionPrefix = `${collection}@`;
  for (const key of [...configuredModelCache.keys()]) {
    if (
      key === collection ||
      key.startsWith(unversionedPrefix) ||
      key.startsWith(versionPrefix)
    ) {
      configuredModelCache.delete(key);
    }
  }
}

/**
 * Build (or reuse) the model for a `nimbus.config.ts`-declared collection —
 * the render-side entry point a copied `/<collection>/[...slug]` route uses.
 * Reads the same `api[]` declaration the loader indexed and re-derives the
 * model from the spec (memoized per graph), so render never depends on the
 * loader's cache surviving the content-sync → render phase boundary.
 *
 * For a version family, pass the `version` to select a non-default version;
 * omitting it selects the family default (the bare `/<collection>` URL).
 */
export async function getApiModel(
  collection: string,
  version?: string,
): Promise<ApiModel> {
  const { loadApiBuildConfig } =
    await import("../_internal/api/runtime-build-config.js");
  const { resolveSpecSource } =
    await import("../_internal/api/resolve-spec.js");
  const { resolveApiVersion } =
    await import("../_internal/api/resolve-versions.js");
  const { api, root } = await loadApiBuildConfig();
  const resolved = resolveApiVersion(api, collection, version ?? null);
  if (!resolved) {
    const suffix = version ? ` version "${version}"` : "";
    throw new Error(
      `nimbus-docs api: no spec registered for collection "${collection}"${suffix}. ` +
        `Declare it in \`nimbus.config.ts\`: api: [{ collection: "${collection}", spec: "./openapi.yaml" }].`,
    );
  }

  // The cache key carries the version so two versions of one family never
  // alias (they share a namespace but not a spec/mount).
  const cacheKey = resolved.versionKey;
  const cached = configuredModelCache.get(cacheKey);
  if (cached) return cached;

  // Resolve against the loader's base (astroConfig.root), not process.cwd() —
  // they differ under monorepo/subpackage/`--root`/Cloudflare builds.
  const promise = resolveSpecSource(
    {
      collection: resolved.namespace,
      spec: resolved.spec,
      label: resolved.label,
      mountPath: resolved.mountPath,
      requireOperationId: resolved.requireOperationId,
      routes: resolved.routes,
    },
    root,
  ).then(buildApiModel);
  configuredModelCache.set(cacheKey, promise);
  // Never leave a rejected load cached — an editor's atomic write-then-rename
  // can transiently fail before the content watcher sees the replacement.
  promise.catch(() => {
    if (configuredModelCache.get(cacheKey) === promise) {
      configuredModelCache.delete(cacheKey);
    }
  });
  return promise;
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

/** Coordinate → `resource-action-v1` route provenance for each operation page routed under
 *  a policy (`override`/`derived`/`fallback`). Empty for legacy collections.
 *  The loader's cross-version drift check compares `derived` slugs only. A fresh
 *  copy each call, so a caller can never mutate the memoized model's provenance. */
export function getApiRouteProvenance(
  model: ApiModel,
): ReadonlyMap<string, ApiRouteProvenance> {
  return new Map(routeProvenance(unwrap(model)));
}

/** Every field coordinate that resolves to a rendered in-page anchor, as
 *  `{ coordinate, slug, anchor }`. The citation index turns each into
 *  `<pageUrl>#<anchor>`; fields the renderer omits (truncated/inline) are never
 *  surfaced. */
export function getApiFieldCitations(
  model: ApiModel,
): Array<{ coordinate: string; slug: string; anchor: string }> {
  return fieldCitations(unwrap(model));
}

/** Each page's slug plus display title/description, in one pass. The loader
 * seeds the agent index from this so it never carries the model past the
 * content-sync → render boundary. */
export function getApiPageIndex(model: ApiModel): ApiPageIndexEntry[] {
  return indexPages(unwrap(model));
}
