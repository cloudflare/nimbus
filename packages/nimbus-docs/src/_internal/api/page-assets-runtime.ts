import type { CollectionEntry } from "astro:content";
import {
  createPageAssetReader,
  type PageAssetRow,
  type ParsedPageAssetIndex,
} from "../page-assets.js";
import { readStagedAsset } from "../staged-asset-reader.js";
import { loadNimbusConfig } from "../runtime-config.js";
import {
  apiPageRoute,
  pageUrl,
  resolveApiFamily,
  targetUrlFields,
  type ResolvedApiVersion,
} from "./resolve-versions.js";
import {
  activatePreparedApiNav,
  isPreparedApiNav,
  isPreparedApiPage,
  preparedApiVersion,
  type PreparedApiNav,
} from "./prepared.js";
import { applyApiSidebarMode } from "./nav-bounds.js";
import type { ApiPageProps } from "./api-view-types.js";

export type ApiPageAssetManifest = Record<string, Record<string, string>>;
export interface ApiAssetMetadata {
  nav: PreparedApiNav;
  matches: Record<string, string>;
  canonicalSlugs: Record<string, string | null>;
}

const reader = createPageAssetReader({ readAsset: readStagedAsset });
const checkedIndexes = new WeakSet<object>();
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export async function apiPageAssets(): Promise<ApiPageAssetManifest> {
  const config = await import("virtual:nimbus/config");
  return config.pageAssets ?? {};
}

export async function hasApiPageAssets(collection: string): Promise<boolean> {
  return Object.hasOwn(await apiPageAssets(), collection);
}

// The config is fixed for an isolate's life; one page asks several times.
const targetsByCollection = new Map<string, Promise<ResolvedApiVersion[]>>();
export function apiAssetTargets(
  collection: string,
): Promise<ResolvedApiVersion[]> {
  let targets = targetsByCollection.get(collection);
  if (!targets) {
    targets = loadNimbusConfig().then((config) => {
      const entry = config.api?.find(
        (entry) => entry.collection === collection,
      );
      return entry ? resolveApiFamily(entry) : [];
    });
    targetsByCollection.set(collection, targets);
  }
  return targets;
}

export async function readApiAssetIndex(
  target: ResolvedApiVersion,
  request?: Request,
): Promise<ParsedPageAssetIndex> {
  const filename = (await apiPageAssets())[target.family]?.[
    target.version ?? ""
  ];
  if (!filename)
    throw new Error(
      `Missing page asset index for ${target.versionKey}. Rebuild the site.`,
    );
  return reader.readIndex(filename, { request });
}

export function apiAssetMetadata(
  index: ParsedPageAssetIndex,
): ApiAssetMetadata {
  const metadata = index.metadata as ApiAssetMetadata | undefined;
  if (checkedIndexes.has(index)) return metadata!;
  if (
    !metadata ||
    !isPreparedApiNav(metadata.nav) ||
    !object(metadata.matches) ||
    !object(metadata.canonicalSlugs) ||
    !Array.isArray(metadata.nav.nav.items) ||
    !object(metadata.nav.paths)
  ) {
    throw new Error("Invalid prepared API index metadata. Rebuild the site.");
  }
  for (const [id, key] of Object.entries(metadata.matches))
    if (!index.byId.has(id) || typeof key !== "string" || !key)
      throw new Error("Invalid API match identity.");
  for (const [id, slug] of Object.entries(metadata.canonicalSlugs))
    if (!index.byId.has(id) || (slug !== null && typeof slug !== "string"))
      throw new Error("Invalid API canonical target.");
  for (const path of Object.values(metadata.nav.paths))
    if (!Array.isArray(path) || path.some((item) => typeof item !== "string"))
      throw new Error("Invalid API navigation path.");
  const nodes = [...metadata.nav.nav.items];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (
      !node ||
      typeof node.coordinate !== "string" ||
      typeof node.label !== "string" ||
      !Array.isArray(node.children)
    )
      throw new Error("Invalid API navigation item.");
    nodes.push(...node.children);
  }
  checkedIndexes.add(index);
  return metadata;
}

function assetEntry(
  target: ResolvedApiVersion,
  row: PageAssetRow,
): CollectionEntry<string> {
  return {
    id: apiPageRoute(target, row.slug).storeId,
    collection: target.family,
    data: {
      coordinate: row.id,
      title: row.title,
      description: row.description,
      ...(target.version ? { version: target.version } : {}),
    },
  } as CollectionEntry<string>;
}

/** Default-only enumeration for discovery. Individual historical lookups remain available. */
export async function getApiAssetEntries(
  collection: string,
  request?: Request,
): Promise<CollectionEntry<string>[]> {
  const target = (await apiAssetTargets(collection)).find(
    (target) => target.isDefault,
  );
  if (!target) return [];
  const index = await readApiAssetIndex(target, request);
  return index.rows.map((row) => assetEntry(target, row));
}

export async function getApiAssetEntry(
  collection: string,
  storeId: string,
  request?: Request,
): Promise<CollectionEntry<string> | null> {
  const targets = await apiAssetTargets(collection);
  const [first, ...rest] = storeId.split("/");
  const historical = targets.find(
    (target) => !target.isDefault && target.version === first,
  );
  const target = historical ?? targets.find((target) => target.isDefault);
  if (!target) return null;
  const slug = historical ? rest.join("/") : storeId === "index" ? "" : storeId;
  const row = (await readApiAssetIndex(target, request)).bySlug.get(slug);
  return row ? assetEntry(target, row) : null;
}

export async function getApiAssetPage(
  collection: string,
  version: string | null,
  id: string,
  request?: Request,
) {
  const targets = await apiAssetTargets(collection);
  const target = targets.find((candidate) => candidate.version === version);
  if (!target)
    throw new Error(`Unknown API page version ${collection}@${version}.`);
  const index = await readApiAssetIndex(target, request);
  const row = index.byId.get(id);
  if (!row) throw new Error(`Missing API page ${id}.`);
  const record = await reader.readRecord(row.location, { request });
  if (
    !object(record) ||
    record.apiSchemaVersion !== 1 ||
    record.coordinate !== id ||
    record.collection !== collection ||
    typeof record.title !== "string" ||
    typeof record.href !== "string" ||
    !["api", "section", "schema", "operation"].includes(String(record.kind)) ||
    !isPreparedApiPage({
      version: preparedApiVersion,
      navEntryId: "",
      page: record,
    })
  ) {
    throw new Error(
      `Invalid prepared API page record for ${id}. Rebuild the site.`,
    );
  }
  const { resolveApiAssetLinks } = await import("./page-assets-links.js");
  const page = resolveApiAssetLinks(record, target, index) as ApiPageProps;
  const prepared = apiAssetMetadata(index).nav;
  const nav = activatePreparedApiNav(prepared, id);
  return {
    page,
    nav: applyApiSidebarMode(nav, {
      mode: target.sidebar,
      mountPath: target.mountPath,
      ...targetUrlFields(target),
      overview: page.kind === "api",
    }),
  };
}

export async function resolveApiAssetSwitch(
  collection: string,
  sourceVersion: string,
  id: string,
  targetVersion: string,
  request?: Request,
): Promise<string | null> {
  const targets = await apiAssetTargets(collection);
  const source = targets.find((target) => target.version === sourceVersion);
  const destination = targets.find(
    (target) => target.version === targetVersion,
  );
  if (!source || !destination) return null;
  const from = await readApiAssetIndex(source, request);
  if (!from.byId.has(id)) return null;
  const to =
    source === destination
      ? from
      : await readApiAssetIndex(destination, request);
  const fromMatches = apiAssetMetadata(from).matches;
  const match = Object.hasOwn(fromMatches, id) ? fromMatches[id] : id;
  const toMatches = apiAssetMetadata(to).matches;
  const row = to.rows.find(
    (row) =>
      (Object.hasOwn(toMatches, row.id) ? toMatches[row.id] : row.id) === match,
  );
  return pageUrl(destination, row?.slug ?? "");
}

export async function getApiAssetCanonical(
  collection: string,
  version: string,
  id: string,
  request?: Request,
): Promise<string | null> {
  const targets = await apiAssetTargets(collection);
  const target = targets.find((target) => target.version === version);
  if (!target || target.isDefault) return null;
  const index = await readApiAssetIndex(target, request);
  const row = index.byId.get(id);
  if (!row) return null;
  const canonicals = apiAssetMetadata(index).canonicalSlugs;
  const slug = Object.hasOwn(canonicals, id) ? canonicals[id] : row.slug;
  const destination = targets.find((target) => target.isDefault);
  return destination && typeof slug === "string"
    ? pageUrl(destination, slug)
    : null;
}
