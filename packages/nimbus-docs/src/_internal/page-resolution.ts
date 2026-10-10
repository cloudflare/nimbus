import type { CollectionEntry } from "astro:content";
import type { AstroComponentFactory } from "astro/runtime/server/index.js";

import type { ApiNav, ApiPageProps } from "../api/index.js";
import {
  collectionMountPrefix,
  PRIMARY_COLLECTION,
  type VersionInfo,
} from "./collection-mount.js";
import type { ProjectionContext } from "./projection.js";
import {
  LEGACY_VERSION_PARAM,
  selectApiVersion,
  type ApiQueryRouting,
} from "./api/resolve-versions.js";
import { toRouteKey } from "./url.js";

export interface PageIdentity {
  pathname: string;
  collection: string;
  locale?: string;
}

export interface ProsePage {
  kind: "prose";
  identity: PageIdentity;
  entry: CollectionEntry<string>;
  Content: AstroComponentFactory;
  headings: { depth: number; text: string; slug: string }[];
}

export interface ApiPage {
  kind: "api";
  identity: PageIdentity;
  page: ApiPageProps;
  nav: ApiNav;
  collection: string;
  version: string | null;
  coordinate: string;
}

export type PageResolution<
  P extends ProsePage | ApiPage = ProsePage | ApiPage,
> =
  | { status: "found"; page: P }
  | { status: "redirect"; location: string; permanent: boolean }
  | { status: "not-found" };

export interface PageResolutionContext {
  props: Record<string, unknown>;
  params: Record<string, string | undefined>;
  url: URL;
  projection?: ProjectionContext;
}

interface ProseResolutionDependencies {
  getVisibleEntry(
    collection: string,
    id: string,
    projection?: ProjectionContext,
  ): Promise<CollectionEntry<string> | null>;
  getVersions(): Promise<VersionInfo | null>;
  render(entry: CollectionEntry<string>): Promise<{
    Content: AstroComponentFactory;
    headings: { depth: number; text: string; slug: string }[];
  }>;
}

export type { ApiQueryRouting as ApiQueryVersionRouting } from "./api/resolve-versions.js";

interface ApiResolutionDependencies {
  getApiCollections(): Promise<readonly string[]>;
  /** Query-mode routing info for a family, or `null` for path mode. */
  getApiQueryRouting?(collection: string): Promise<ApiQueryRouting | null>;
  getVisibleEntry(
    collection: string,
    id: string,
    projection?: ProjectionContext,
  ): Promise<CollectionEntry<string> | null>;
  render(
    collection: string,
    version: string | null,
    coordinate: string,
    entry?: CollectionEntry<string>,
  ): Promise<{ page: ApiPageProps; nav: ApiNav }>;
}

/** The same URL with 0.17's `api-version` renamed to `param`, or `null`. */
function legacyVersionLocation(url: URL, param: string): string | null {
  const params = url.searchParams;
  if (param === LEGACY_VERSION_PARAM || params.has(param)) return null;
  const value = params.get(LEGACY_VERSION_PARAM);
  if (value === null) return null;
  const next = new URLSearchParams();
  for (const [key, entry] of params)
    next.append(key === LEGACY_VERSION_PARAM ? param : key, entry);
  return `${url.pathname}?${next}`;
}

function normalizedPathname(url: URL): string {
  return toRouteKey(url.pathname);
}

function normalizedPageId(param: string | undefined): string {
  if (!param) return "index";
  const route = toRouteKey(`/${param}`);
  return route === "/" ? "index" : route.slice(1);
}

function mountedCollectionSegment(
  context: PageResolutionContext,
): string | null {
  const pathname = normalizedPathname(context.url);
  const pathSegments = pathname.split("/").filter(Boolean);
  const param = context.params.slug;
  if (!param) return pathSegments.at(-1) ?? null;

  const paramSegments = normalizedPageId(param).split("/");
  const suffix = pathSegments.slice(-paramSegments.length);
  if (suffix.join("/") !== paramSegments.join("/")) return null;
  return pathSegments.at(-(paramSegments.length + 1)) ?? null;
}

async function requestProseIdentity(
  context: PageResolutionContext,
  collection: string | undefined,
  getVersions: () => Promise<VersionInfo | null>,
): Promise<{ collection: string; id: string } | null> {
  const id = normalizedPageId(context.params.slug);
  const versions = await getVersions();
  const [first, ...rest] = id === "index" ? [] : id.split("/");
  const mount = mountedCollectionSegment(context);
  if (
    first &&
    versions?.others.includes(first) &&
    ((!collection && !mount) ||
      collection === PRIMARY_COLLECTION ||
      collection === `${PRIMARY_COLLECTION}-${first}`)
  ) {
    return {
      collection: `${PRIMARY_COLLECTION}-${first}`,
      id: rest.join("/") || "index",
    };
  }

  if (collection) return { collection, id };
  if (!mount) return null;

  const candidate = versions?.others.includes(mount)
    ? `${PRIMARY_COLLECTION}-${mount}`
    : mount;
  return collectionMountPrefix(candidate, versions) === `/${mount}`
    ? { collection: candidate, id }
    : null;
}

export async function resolveProsePage(
  context: PageResolutionContext,
  options: { collection?: string },
  dependencies: ProseResolutionDependencies,
): Promise<PageResolution<ProsePage>> {
  const staticEntry = context.props.entry as
    CollectionEntry<string> | undefined;
  const requestIdentity = staticEntry
    ? null
    : await requestProseIdentity(
        context,
        options.collection,
        dependencies.getVersions,
      );
  const collection = staticEntry?.collection ?? requestIdentity?.collection;
  if (!collection || (!staticEntry && !requestIdentity)) {
    return { status: "not-found" };
  }

  const entry =
    staticEntry ??
    (await dependencies.getVisibleEntry(
      collection,
      requestIdentity!.id,
      context.projection,
    ));
  if (!entry) return { status: "not-found" };

  const rendered = await dependencies.render(entry);
  return {
    status: "found",
    page: {
      kind: "prose",
      identity: { pathname: normalizedPathname(context.url), collection },
      entry,
      ...rendered,
    },
  };
}

export async function resolveApiPage(
  context: PageResolutionContext,
  options: { collection?: string },
  dependencies: ApiResolutionDependencies,
): Promise<PageResolution<ApiPage>> {
  const staticCollection =
    typeof context.props.collection === "string"
      ? context.props.collection
      : undefined;
  const staticCoordinate =
    typeof context.props.coordinate === "string"
      ? context.props.coordinate
      : undefined;
  const hasStaticIdentity =
    staticCollection !== undefined && staticCoordinate !== undefined;

  let collection = staticCollection ?? options.collection;
  let version =
    typeof context.props.version === "string" ? context.props.version : null;
  let coordinate = staticCoordinate;
  let entry = context.props.entry as CollectionEntry<string> | undefined;

  if (hasStaticIdentity && !entry) {
    entry =
      (await dependencies.getVisibleEntry(
        collection!,
        normalizedPageId(context.params.slug),
        context.projection,
      )) ?? undefined;
    if (!entry) return { status: "not-found" };
  } else if (!hasStaticIdentity) {
    const apiCollections = await dependencies.getApiCollections();
    collection ??= mountedCollectionSegment(context) ?? undefined;
    if (!collection || !apiCollections.includes(collection)) {
      return { status: "not-found" };
    }

    const id = normalizedPageId(context.params.slug);
    if (id === "index" && context.params.slug !== undefined) {
      return { status: "not-found" };
    }

    // Query mode: resolution is `(version, slug) → entry`, and the found
    // entry must belong to the selected version. Store ids are not routes:
    // `/family/v2/foo` with no query selects the default version, looks up
    // the id "v2/foo", finds the v2 entry, sees the mismatch, and 404s.
    const queryRouting =
      (await dependencies.getApiQueryRouting?.(collection)) ?? null;
    if (queryRouting) {
      const selected = selectApiVersion(context.url.searchParams, queryRouting);
      if (selected === null) return { status: "not-found" };
      const isDefault = selected === queryRouting.defaultVersion;
      const storeId = isDefault
        ? id
        : id === "index"
          ? selected
          : `${selected}/${id}`;
      entry =
        (await dependencies.getVisibleEntry(
          collection,
          storeId,
          context.projection,
        )) ?? undefined;
      if (!entry) return { status: "not-found" };
      const entryVersion =
        typeof entry.data.version === "string" ? entry.data.version : null;
      if (entryVersion !== selected) return { status: "not-found" };
      coordinate =
        typeof entry.data.coordinate === "string"
          ? entry.data.coordinate
          : undefined;
      version = selected;
      if (!coordinate) return { status: "not-found" };
      const legacy = legacyVersionLocation(context.url, queryRouting.param);
      if (legacy)
        return { status: "redirect", location: legacy, permanent: true };
    } else {
      entry =
        (await dependencies.getVisibleEntry(
          collection,
          id,
          context.projection,
        )) ?? undefined;
      if (!entry) return { status: "not-found" };

      coordinate =
        typeof entry.data.coordinate === "string"
          ? entry.data.coordinate
          : undefined;
      version =
        typeof entry.data.version === "string" ? entry.data.version : null;
      if (!coordinate) {
        return { status: "not-found" };
      }
    }
  }

  const rendered = await dependencies.render(
    collection!,
    version,
    coordinate!,
    entry,
  );
  return {
    status: "found",
    page: {
      kind: "api",
      identity: {
        pathname: normalizedPathname(context.url),
        collection: collection!,
      },
      ...rendered,
      collection: collection!,
      version,
      coordinate: coordinate!,
    },
  };
}
