/**
 * Expand a Nimbus config `api[]` declaration into the flat list of render
 * targets — one per version. This is the single source of truth for how a
 * version family maps onto identity, cache keys, and URLs.
 *
 * Three distinct strings come out of one version, and conflating them is the
 * classic footgun:
 *
 *   - `namespace` — the coordinate + model identity. **Always the family name**,
 *     identical across every version. Coordinates become URLs and anchors and
 *     must never carry the version, or the same operation in two versions would
 *     mint different coordinates and never link across versions.
 *   - `versionKey` — the cache + cross-version-alternates + head key. Carries the
 *     version (`family@version`) so two versions of one family stay disjoint in
 *     those maps. Never rendered.
 *   - `mountPath` — the URL base. `/family` for the default, `/family/version`
 *     for the rest.
 *
 * An unversioned collection resolves to a single target that is byte-identical
 * to the pre-versioning behaviour (`namespace` = `versionKey` = family,
 * `mountPath` = `/family`).
 */

import type { ApiRoutePolicy, ApiSpec, ApiVersionSpec, ApiVersionStatus } from "../../types.js";
import type { RoutePolicy } from "./route-policy.js";

/** One fully-resolved render target — a single version of one API family. */
export interface ResolvedApiVersion {
  /** The `api[].collection` this belongs to (shared base + namespace). */
  family: string;
  /** Version id, or `null` for an unversioned collection. */
  version: string | null;
  /** Whether this is the family default (owns the bare `/family` URL). */
  isDefault: boolean;
  /** Coordinate + model identity. Always the family name (see module docs). */
  namespace: string;
  /** Cache + alternates-table + head key: `family` or `family@version`. */
  versionKey: string;
  /** URL base: `/family` (default) or `/family/version`. */
  mountPath: string;
  /** Spec source for this version (path or inline object). */
  spec: string | Record<string, unknown>;
  /** Maturity status, or `null` when unset. */
  status: ApiVersionStatus | null;
  /** Hidden from picker/search/sitemap; reachable by direct URL. */
  hidden: boolean;
  /** Display label (picker + diagnostics). */
  label: string;
  /** Fail the build on an operation missing a usable `operationId`. Default false. */
  requireOperationId: boolean;
  /** Route convention for this target, or `undefined` for legacy operationId URLs. */
  routes?: RoutePolicy;
}

/** An `ApiRoutePolicy` is structurally the engine's `RoutePolicy`; narrow once here. */
function asRoutePolicy(routes: ApiRoutePolicy | undefined): RoutePolicy | undefined {
  return routes as RoutePolicy | undefined;
}

const VERSION_KEY_SEP = "@";

function defaultVersionOf(versions: ApiVersionSpec[]): ApiVersionSpec {
  return versions.find((v) => v.default) ?? versions[0]!;
}

// The content loader (store id) and getApiStaticPaths (route param) MUST agree
// here or a page's HTML route, Markdown version, and sitemap URL diverge — so both
// derive from this one function.
export function apiPageRoute(
  target: Pick<ResolvedApiVersion, "isDefault" | "version">,
  slug: string,
): { storeId: string; param: string | undefined } {
  if (slug === "") {
    return target.isDefault
      ? { storeId: "index", param: undefined }
      : { storeId: target.version!, param: target.version! };
  }
  const joined = target.isDefault ? slug : `${target.version}/${slug}`;
  return { storeId: joined, param: joined };
}

/** Resolve one family into its render targets (one per version). */
export function resolveApiFamily(entry: ApiSpec): ResolvedApiVersion[] {
  const family = entry.collection;

  if (!entry.versions || entry.versions.length === 0) {
    return [
      {
        family,
        version: null,
        isDefault: true,
        namespace: family,
        versionKey: family,
        mountPath: `/${family}`,
        spec: entry.spec as string | Record<string, unknown>,
        status: null,
        hidden: false,
        label: entry.label ?? family,
        requireOperationId: entry.requireOperationId ?? false,
        routes: asRoutePolicy(entry.routes),
      },
    ];
  }

  const def = defaultVersionOf(entry.versions);
  return entry.versions.map((v) => {
    const isDefault = v === def;
    return {
      family,
      version: v.version,
      isDefault,
      namespace: family,
      versionKey: `${family}${VERSION_KEY_SEP}${v.version}`,
      mountPath: isDefault ? `/${family}` : `/${family}/${v.version}`,
      spec: v.spec,
      status: v.status ?? null,
      hidden: v.hidden ?? false,
      label: v.label ?? v.version,
      requireOperationId: entry.requireOperationId ?? false,
      routes: asRoutePolicy(v.routes),
    };
  });
}

/** Every render target across every declared family. */
export function resolveAllApiCollections(
  api: ApiSpec[] | undefined,
): ResolvedApiVersion[] {
  return (api ?? []).flatMap(resolveApiFamily);
}

/**
 * Resolve one target by collection + version. Omitting `version` (or passing
 * `null`) selects the family default — the render path for the bare
 * `/family` URL.
 */
export function resolveApiVersion(
  api: ApiSpec[] | undefined,
  collection: string,
  version?: string | null,
): ResolvedApiVersion | undefined {
  const entry = (api ?? []).find((a) => a.collection === collection);
  if (!entry) return undefined;
  const resolved = resolveApiFamily(entry);
  if (version == null) return resolved.find((r) => r.isDefault);
  return resolved.find((r) => r.version === version);
}
