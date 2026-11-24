import type { CollectionEntry } from "astro:content";
import type { AstroComponentFactory } from "astro/runtime/server/index.js";

import type { ApiNav, ApiPageProps } from "../api/index.js";
import {
  COLLECTION_URLS_DOCS,
  PRIMARY_COLLECTION,
  routeFolder,
  type VersionInfo,
} from "./collection-mount.js";
import type { ProjectionContext } from "./projection.js";
import {
  LEGACY_VERSION_PARAM,
  selectApiVersion,
  type ApiQueryRouting,
} from "./api/resolve-versions.js";
import { parseApiHomePart } from "./api/home-index.js";
import { entryRouteKey } from "./astro-slug.js";
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

/** What reading an API page returns: the page and its navigation, or, for a
 *  caller that needs only the sidebar, the navigation alone. */
export type ApiPageRead = { page: ApiPageProps; nav: ApiNav };

export type ApiPage<R extends object = ApiPageRead> = R & {
  kind: "api";
  identity: PageIdentity;
  collection: string;
  version: string | null;
  coordinate: string;
  /** The part of the API home's list a `<home>/index/<n>/` URL names. */
  homePart?: number;
};

export type PageResolution<
  P extends ProsePage | ApiPage<object> = ProsePage | ApiPage,
> =
  | { status: "found"; page: P }
  | { status: "redirect"; location: string; permanent: boolean }
  | { status: "not-found" };

export interface PageResolutionContext {
  props: Record<string, unknown>;
  params: Record<string, string | undefined>;
  url: URL;
  /** The route's Astro pattern, without `base`: `/products/sdk/[...slug]`. */
  routePattern: string;
  projection?: ProjectionContext;
}

interface RouteResolutionDependencies {
  /** The page collection a route folder serves (`""` is the root), if any. */
  getCollectionAt(folder: string): Promise<string | undefined>;
  /** Reports a route under a folder no collection is served from. */
  warn(message: string): void;
}

interface ProseResolutionDependencies extends RouteResolutionDependencies {
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

interface ApiResolutionDependencies<R extends object = ApiPageRead> extends RouteResolutionDependencies {
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
  ): Promise<R>;
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

/**
 * The folder a request route serves: from its pattern, which is base-free and
 * exact, so nested URLs need no prefix matching. A route with a dynamic folder
 * (`/[locale]/[...slug]`) falls back to the URL segment before the page, and
 * isn't `exact`.
 */
function requestFolder(context: PageResolutionContext): { folder: string; exact: boolean } | null {
  const folder = routeFolder(context.routePattern);
  if (folder !== undefined) return { folder, exact: true };
  const segment = mountedCollectionSegment(context);
  return segment === null ? null : { folder: `/${segment}`, exact: false };
}

/** Whether a request route has no folder of its own, like the root route. */
function isRootRoute(context: PageResolutionContext): boolean {
  return !requestFolder(context)?.folder;
}

const reportedRoutes = new Set<string>();

async function requestCollection(
  context: PageResolutionContext,
  dependencies: RouteResolutionDependencies,
): Promise<string | null> {
  const route = requestFolder(context);
  if (!route) return null;
  const collection = await dependencies.getCollectionAt(route.folder);
  if (collection !== undefined) return collection;
  if (route.exact && !reportedRoutes.has(context.routePattern)) {
    reportedRoutes.add(context.routePattern);
    dependencies.warn(
      `nimbus-docs: the route ${context.routePattern} renders on request, but no page collection is served from ` +
        `${route.folder || "/"}. Page collections come from docsCollection() or withNimbusMarkdown(). To serve one here, ` +
        `name it in this route's page helper, such as getCollectionPage(Astro, "<name>"), or its exported getStaticPaths; ` +
        `otherwise move the route to /<name>. ` +
        `See ${COLLECTION_URLS_DOCS}.`,
    );
  }
  return null;
}

/**
 * The collection and entry id a request names, and its `slug`: the page's
 * route within the collection, which only the entry's own URL matches.
 */
async function requestProseIdentity(
  context: PageResolutionContext,
  collection: string | undefined,
  dependencies: ProseResolutionDependencies,
): Promise<{ collection: string; id: string; slug: string } | null> {
  const slug = context.params.slug ? toRouteKey(`/${context.params.slug}`).slice(1) : "";
  const id = slug || "index";
  const versions = await dependencies.getVersions();
  const [first, ...rest] = slug ? slug.split("/") : [];
  // Only the root route's slug carries a version's prefix; a version's own route starts below it.
  if (
    first &&
    versions?.others.includes(first) &&
    isRootRoute(context) &&
    (!collection || collection === PRIMARY_COLLECTION || collection === `${PRIMARY_COLLECTION}-${first}`)
  ) {
    return {
      collection: `${PRIMARY_COLLECTION}-${first}`,
      id: rest.join("/") || "index",
      slug: rest.join("/"),
    };
  }

  if (collection) return { collection, id, slug };
  const found = await requestCollection(context, dependencies);
  return found ? { collection: found, id, slug } : null;
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
    : await requestProseIdentity(context, options.collection, dependencies);
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
  // `/index` and `/<folder>/index` find the landing; only its own URL serves it.
  if (requestIdentity && entryRouteKey(entry.id) !== requestIdentity.slug) return { status: "not-found" };

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

export async function resolveApiPage<R extends object = ApiPageRead>(
  context: PageResolutionContext,
  options: { collection?: string },
  dependencies: ApiResolutionDependencies<R>,
): Promise<PageResolution<ApiPage<R>>> {
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
  // A built part names itself in its props; only a request parses its URL.
  let homePart =
    typeof context.props.homePart === "number" ? context.props.homePart : undefined;

  if (hasStaticIdentity && !entry) {
    const slugId = normalizedPageId(context.params.slug);
    const id = homePart ? (parseApiHomePart(slugId)?.homeId ?? slugId) : slugId;
    entry =
      (await dependencies.getVisibleEntry(
        collection!,
        id,
        context.projection,
      )) ?? undefined;
    if (!entry) return { status: "not-found" };
  } else if (!hasStaticIdentity) {
    const apiCollections = await dependencies.getApiCollections();
    collection ??= (await requestCollection(context, dependencies)) ?? undefined;
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
    const selected = queryRouting
      ? selectApiVersion(context.url.searchParams, queryRouting)
      : undefined;
    if (selected === null) return { status: "not-found" };
    const find = async (pageId: string) => {
      const storeId =
        !queryRouting || selected === queryRouting.defaultVersion
          ? pageId
          : pageId === "index"
            ? selected!
            : `${selected}/${pageId}`;
      const found = await dependencies.getVisibleEntry(
        collection!,
        storeId,
        context.projection,
      );
      if (!found) return undefined;
      const foundVersion =
        typeof found.data.version === "string" ? found.data.version : null;
      if (queryRouting && foundVersion !== selected) return undefined;
      return found;
    };

    // A page's own URL wins: `index` is reserved only at the top, so an
    // operation can end in `…/index/2`.
    entry = await find(id);
    if (!entry) {
      const part = parseApiHomePart(id);
      const home = part ? await find(part.homeId) : undefined;
      if (!home || home.data.coordinate !== collection) return { status: "not-found" };
      entry = home;
      homePart = part!.part;
    }
    coordinate =
      typeof entry.data.coordinate === "string"
        ? entry.data.coordinate
        : undefined;
    version = queryRouting
      ? selected!
      : typeof entry.data.version === "string"
        ? entry.data.version
        : null;
    if (!coordinate) return { status: "not-found" };
    if (queryRouting) {
      const legacy = legacyVersionLocation(context.url, queryRouting.param);
      if (legacy)
        return { status: "redirect", location: legacy, permanent: true };
    }
  }

  // Only the API home has later parts.
  if (homePart && coordinate !== collection) return { status: "not-found" };

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
      ...(homePart ? { homePart } : {}),
    },
  };
}
