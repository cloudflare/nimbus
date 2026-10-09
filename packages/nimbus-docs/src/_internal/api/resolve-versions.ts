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

import type {
  ApiRoutePolicy,
  ApiSamples,
  ApiSidebarMode,
  ApiSpec,
  ApiVersionSpec,
  ApiVersionStatus,
} from "../../types.js";
import type { RoutePolicy } from "./route-policy.js";
import { toDocumentHref } from "../url.js";

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
  /** Publish a page per `components/schemas` entry. Family-wide; default false. */
  schemaPages: boolean;
  /** Publish the self-contained spec file. Version override, else family, else true. */
  publishSpec: boolean;
  /** Code sample policy. Family-wide. */
  samples?: ApiSamples;
  /** Route convention for this target, or `undefined` for legacy operationId URLs. */
  routes?: RoutePolicy;
  /** How much navigation each page includes. Family-wide; default `"full"`. */
  sidebar: ApiSidebarMode;
  /** How versions are addressed in URLs. Family-wide; default `"path"`. */
  versionMode: "path" | "query";
  /** The query parameter that carries the version. Family-wide. */
  versionParam: string;
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

/** The slug an `apiPageRoute` store id was built from. */
export function apiPageSlug(
  target: Pick<ResolvedApiVersion, "isDefault" | "version">,
  storeId: string,
): string {
  if (target.isDefault) return storeId === "index" ? "" : storeId;
  return storeId === target.version
    ? ""
    : storeId.slice(`${target.version}/`.length);
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
        schemaPages: entry.schemaPages ?? false,
        publishSpec: entry.publishSpec ?? true,
        samples: entry.samples,
        routes: asRoutePolicy(entry.routes),
        sidebar: entry.sidebar ?? "full",
        versionMode: "path",
        versionParam: entry.versionParam ?? DEFAULT_VERSION_PARAM,
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
      schemaPages: entry.schemaPages ?? false,
      publishSpec: v.publishSpec ?? entry.publishSpec ?? true,
      samples: entry.samples,
      routes: asRoutePolicy(v.routes),
      sidebar: entry.sidebar ?? "full",
      versionMode: entry.versionMode ?? "path",
      versionParam: entry.versionParam ?? DEFAULT_VERSION_PARAM,
    };
  });
}

/** The query parameter that carries the version in query mode, by default. */
export const DEFAULT_VERSION_PARAM = "version";
/** 0.17's parameter name; requests using it still select a version. */
export const LEGACY_VERSION_PARAM = "api-version";

/**
 * The one URL builder every producer goes through. In path mode a page's URL
 * is its mount path plus the slug, as always. In query mode every version
 * shares the version-free `/<family>/<slug>` URL, and a non-default target
 * appends `?<versionParam>=<id>` — links whose job is to stay inside a
 * non-default version carry it; the default's links carry none.
 */
export function pageUrl(
  target: Pick<
    ResolvedApiVersion,
    "family" | "mountPath" | "versionMode" | "isDefault" | "version"
    | "versionParam"
  >,
  slug: string,
): string {
  const base =
    target.versionMode === "query" ? `/${target.family}` : target.mountPath;
  const path = slug === "" ? base : `${base}/${slug}`;
  return `${toDocumentHref(path)}${apiVersionQuery(target)}`;
}

/** The `?version=` suffix a non-default query-mode target's links carry. */
export function apiVersionQuery(
  target: Pick<
    ResolvedApiVersion,
    "versionMode" | "isDefault" | "version" | "versionParam"
  >,
): string {
  return target.versionMode === "query" && !target.isDefault && target.version
    ? `?${target.versionParam}=${encodeURIComponent(target.version)}`
    : "";
}

/**
 * The SpecSource/bounds URL fields a target contributes. Query-mode targets
 * publish at the version-free family base with the version in the query;
 * path-mode targets contribute nothing (mountPath already carries the URL).
 */
export function targetUrlFields(
  target: Pick<
    ResolvedApiVersion,
    "family" | "versionMode" | "isDefault" | "version" | "versionParam"
  >,
): { urlBasePath?: string; urlQuery?: string } {
  if (target.versionMode !== "query") return {};
  const query = apiVersionQuery(target);
  return {
    urlBasePath: `/${target.family}`,
    ...(query ? { urlQuery: query } : {}),
  };
}

/** Query-mode routing for one family: its default and every valid id. */
export interface ApiQueryRouting {
  defaultVersion: string;
  versions: ReadonlySet<string>;
  /** The query parameter that carries the version. */
  param: string;
}

/** `null` for a path-mode family or an unknown collection. */
export function apiQueryRouting(
  api: ApiSpec[] | undefined,
  collection: string,
): ApiQueryRouting | null {
  const entry = (api ?? []).find((candidate) => candidate.collection === collection);
  if (!entry || entry.versionMode !== "query" || !entry.versions) return null;
  const fallback = entry.versions.find((v) => v.default) ?? entry.versions[0];
  return {
    defaultVersion: fallback!.version,
    versions: new Set(entry.versions.map((v) => v.version)),
    param: entry.versionParam ?? DEFAULT_VERSION_PARAM,
  };
}

/**
 * The version a request selects, or `null` when it selects none: an unknown
 * id, or the parameter given more than once (caches and query-sorting
 * proxies may reorder repeats, so no value wins). Absent or empty selects the
 * default.
 */
export function selectApiVersion(
  params: URLSearchParams,
  routing: ApiQueryRouting,
): string | null {
  // 0.17 links used `api-version`; honour it when the current name is absent.
  let values = params.getAll(routing.param);
  if (!values.length && routing.param !== LEGACY_VERSION_PARAM)
    values = params.getAll(LEGACY_VERSION_PARAM);
  if (values.length > 1) return null;
  const selected = values[0] ? values[0] : routing.defaultVersion;
  return routing.versions.has(selected) ? selected : null;
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
