/**
 * The citation-index producer — turns the `api[]` declaration into the
 * coordinate → URL contract the citation resolver reads. One build yields
 * `index` (the flat map, consumed directly and baked into
 * `virtual:nimbus/coordinates`) and `manifest` (the published `coordinates.json`
 * payload). Version lives in the path via `mountPath`, never in the coordinate.
 */

import {
  buildApiModel,
  getApiFieldCitations,
  getApiPageProps,
  getApiPageSlugs,
} from "../../api/index.js";
import type { ApiSpec } from "../../types.js";
import { citationKey, isSafeCitationPath } from "./citations.js";
import { resolveSpecSource } from "./resolve-spec.js";
import { resolveAllApiCollections } from "./resolve-versions.js";
import { expandCompactCollection } from "./compact-coordinates.js";
import type { CompactCoordinatesManifest } from "../../types.js";

export type { CoordinatesManifest } from "../../types.js";
import type { CoordinatesManifest } from "../../types.js";

export interface CitationIndexResult {
  /** `collection:coordinate` / `collection@version:coordinate` → URL. */
  index: Map<string, string>;
  manifest: CoordinatesManifest;
}

function pageUrl(mountPath: string, slug: string): string {
  return slug === "" ? mountPath : `${mountPath}/${slug}`;
}

/**
 * Build the citation index + manifest for every declared collection and version.
 * Reuses `buildApiModel`'s content-addressed cache, so a spec parsed here is not
 * re-parsed by the render path. A URL that fails `isSafeCitationPath` is dropped
 * (it can never be a valid page URL) rather than baked.
 */
export async function buildCitationIndex(
  api: ApiSpec[] | undefined,
  root: string,
): Promise<CitationIndexResult> {
  const index = new Map<string, string>();
  // Null-prototype maps: coordinates and collection names come from arbitrary
  // (possibly third-party) specs, so keys like `__proto__` or `constructor`
  // must land as plain own properties, never mutate a prototype.
  const manifest: CoordinatesManifest = { version: 1, collections: Object.create(null) };

  for (const target of resolveAllApiCollections(api)) {
    const source = await resolveSpecSource(
      {
        collection: target.namespace,
        spec: target.spec,
        label: target.label,
        mountPath: target.mountPath,
        requireOperationId: target.requireOperationId,
        routes: target.routes,
      },
      root,
    );
    const model = await buildApiModel(source);

    const collection =
      manifest.collections[target.namespace] ??
      (manifest.collections[target.namespace] = { defaultVersion: null, entries: Object.create(null) });
    if (target.isDefault) collection.defaultVersion = target.version;

    const targets: Array<{ coordinate: string; url: string }> = [];
    for (const { coordinate, slug } of getApiPageSlugs(model)) {
      targets.push({ coordinate, url: pageUrl(target.mountPath, slug) });
      const page = getApiPageProps(model, coordinate);
      if (page.kind === "operation") {
        for (const response of page.responses) {
          targets.push({
            coordinate: response.coordinate,
            url: `${pageUrl(target.mountPath, slug)}#${response.anchor}`,
          });
        }
      }
    }

    for (const { coordinate, slug, anchor } of getApiFieldCitations(model)) {
      targets.push({ coordinate, url: `${pageUrl(target.mountPath, slug)}#${anchor}` });
    }

    for (const { coordinate, url } of targets) {
      if (!isSafeCitationPath(url)) continue;

      const entry = collection.entries[coordinate] ?? (collection.entries[coordinate] = {});
      if (target.version) {
        index.set(citationKey(target.namespace, target.version, coordinate), url);
        (entry.versions ??= Object.create(null))[target.version] = url;
      }
      if (target.isDefault) {
        index.set(citationKey(target.namespace, undefined, coordinate), url);
        entry.url = url;
      }
    }
  }

  return { index, manifest };
}

/**
 * Fold a remote collection's manifest into an existing citation index, under the
 * consumer-declared `collection` name and trusted `origin`. Every value is
 * re-validated on ingest; an unsafe value is dropped with a diagnostic and never
 * baked, so a hostile or buggy manifest cannot inject a dangerous href (the
 * worst it can do is a bad path on an origin the author already trusted).
 */
export function ingestRemoteManifest(
  citationIndex: Map<string, string>,
  collection: string,
  manifest: CoordinatesManifest | CompactCoordinatesManifest,
  origin?: string,
): string[] {
  const diagnostics: string[] = [];
  // An array is a `typeof "object"` too — reject it explicitly at every level so
  // a hostile manifest can't smuggle values in via numeric indices.
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const collectionRecord: unknown = isRecord(manifest.collections) && Object.hasOwn(manifest.collections, collection)
    ? manifest.collections[collection] : undefined;
  if (collectionRecord === undefined) {
    return [`remote manifest for "${collection}" has no such collection (or a malformed one) — citations to it will resolve to "#".`];
  }
  if (manifest.version === 2) {
    const expanded = expandCompactCollection(collectionRecord);
    return [...expanded.diagnostics, ...ingestRemoteManifest(citationIndex, collection, {
      version: 1, collections: { [collection]: expanded.collection },
    }, origin)];
  }
  const entries = isRecord(collectionRecord) ? collectionRecord.entries : undefined;
  if (!isRecord(entries)) {
    diagnostics.push(
      `remote manifest for "${collection}" has no such collection (or a malformed one) — citations to it will resolve to "#".`,
    );
    return diagnostics;
  }
  const trustedOrigin = origin ? origin.replace(/\/$/, "") : "";
  const place = (version: string | undefined, coordinate: string, path: unknown): void => {
    if (typeof path !== "string" || !isSafeCitationPath(path)) {
      diagnostics.push(`remote manifest for "${collection}": dropped unsafe path ${JSON.stringify(path)}.`);
      return;
    }
    citationIndex.set(citationKey(collection, version, coordinate), `${trustedOrigin}${path}`);
  };
  for (const [coordinate, entry] of Object.entries(entries)) {
    if (!isRecord(entry)) {
      diagnostics.push(`remote manifest for "${collection}": dropped malformed entry "${coordinate}".`);
      continue;
    }
    const { url, versions } = entry as { url?: unknown; versions?: unknown };
    if (url !== undefined) place(undefined, coordinate, url);
    if (versions !== undefined) {
      if (!isRecord(versions)) {
        diagnostics.push(`remote manifest for "${collection}": dropped malformed "versions" for "${coordinate}".`);
      } else {
        for (const [version, path] of Object.entries(versions)) place(version, coordinate, path);
      }
    }
  }
  return diagnostics;
}
