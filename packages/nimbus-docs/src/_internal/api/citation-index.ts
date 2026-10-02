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
import type { Coordinate, DocsModel } from "./model.js";
import { unwrapModel } from "./model-handle.js";
import { createPageGroups } from "./coordinate-manifest.js";
import { citationKey, isSafeCitationPath } from "./citations.js";
import { resolveSpecSource } from "./resolve-spec.js";
import { resolveAllApiCollections } from "./resolve-versions.js";

export type { CoordinatesManifest } from "../../types.js";
import type { CoordinatesManifest } from "../../types.js";

export interface CitationIndexResult {
  /** `collection:coordinate` / `collection@version:coordinate` → URL. */
  index: Map<string, string>;
  manifest: CoordinatesManifest;
  /**
   * Citation keys that name a real schema or schema field of a collection with
   * `schemaPages: false` → the schema's name. They have no page to resolve to, so
   * they stay out of `index`; this lets an authored citation fail with a named
   * reason instead of "does not resolve".
   */
  unpublished: Map<string, string>;
}

/** Schema and schema-field coordinates whose schema has no page, mapped to the
 *  schema's name. A field is attributed by walking its parent chain to the
 *  schema node (nested fields parent to their container field). */
function pagelessSchemaCoordinates(model: DocsModel): Map<Coordinate, string> {
  const owner = new Map<Coordinate, string | null>();
  const schemaOf = (coordinate: Coordinate): string | null => {
    const known = owner.get(coordinate);
    if (known !== undefined) return known;
    const node = model.nodes.get(coordinate);
    let result: string | null = null;
    if (node?.kind === "schema" && node.facts.kind === "schema") {
      result = model.pages.pages.has(coordinate) ? null : node.facts.name;
    } else if (node?.kind === "field" && node.parent !== null) {
      result = schemaOf(node.parent);
    }
    owner.set(coordinate, result);
    return result;
  };
  const out = new Map<Coordinate, string>();
  for (const node of model.nodes.values()) {
    if (node.kind !== "schema" && node.kind !== "field") continue;
    const schema = schemaOf(node.id);
    if (schema !== null) out.set(node.id, schema);
  }
  return out;
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
  const unpublished = new Map<string, string>();
  // Null-prototype maps: coordinates and collection names come from arbitrary
  // (possibly third-party) specs, so keys like `__proto__` or `constructor`
  // must land as plain own properties, never mutate a prototype.
  const manifest: CoordinatesManifest = { version: 2, collections: Object.create(null) };

  for (const target of resolveAllApiCollections(api)) {
    const source = await resolveSpecSource(
      {
        collection: target.namespace,
        spec: target.spec,
        label: target.label,
        mountPath: target.mountPath,
        requireOperationId: target.requireOperationId,
        schemaPages: target.schemaPages,
        routes: target.routes,
      },
      root,
    );
    const model = await buildApiModel(source);

    if (!target.schemaPages) {
      for (const [coordinate, schema] of pagelessSchemaCoordinates(unwrapModel(model))) {
        if (target.version) {
          unpublished.set(citationKey(target.namespace, target.version, coordinate), schema);
        }
        if (target.isDefault) {
          unpublished.set(citationKey(target.namespace, undefined, coordinate), schema);
        }
      }
    }

    const collection =
      manifest.collections[target.namespace] ??
      (manifest.collections[target.namespace] = { defaultVersion: null, pages: [] });
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

    const validTargets = targets.filter(({ url }) => isSafeCitationPath(url));
    const pages = createPageGroups(validTargets);
    if (target.version) {
      (collection.versions ??= Object.create(null))[target.version] = pages;
    }
    if (target.isDefault) collection.pages = pages;

    for (const { coordinate, url } of validTargets) {
      if (target.version) {
        index.set(citationKey(target.namespace, target.version, coordinate), url);
      }
      if (target.isDefault) {
        index.set(citationKey(target.namespace, undefined, coordinate), url);
      }
    }
  }

  // Stable transport bytes independent of declaration ordering.
  manifest.collections = Object.assign(Object.create(null), Object.fromEntries(
    Object.entries(manifest.collections).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  ));
  for (const collection of Object.values(manifest.collections)) {
    if (collection.versions) collection.versions = Object.fromEntries(
      Object.entries(collection.versions).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    );
  }
  return { index, manifest, unpublished };
}

export { ingestRemoteManifest } from "./coordinate-manifest.js";
