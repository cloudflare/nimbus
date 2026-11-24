/**
 * The citation-index producer — turns the `api[]` declaration into what the
 * citation resolver reads. One build yields `index` (a `CoordinateIndex` over
 * one compact document per version, also what `virtual:nimbus/coordinates`
 * carries), `manifest` (the published `coordinates.json` index) and
 * `documents` (each published version's file). Version lives in each
 * version's route, never in a coordinate or a document.
 */

import { apiVersionQuery, targetUrlFields } from "./resolve-versions.js";
import { projectMountContext } from "../project-mount-context.js";
import {
  buildApiModel,
  type ApiModel,
  getApiFieldCitations,
  getApiPageProps,
  getApiPageSlugs,
} from "../../api/index.js";
import type { ApiSpec } from "../../types.js";
import type { Coordinate, DocsModel } from "./model.js";
import { unwrapModel } from "./model-handle.js";
import { readFileSync } from "node:fs";

import {
  CoordinateIndex,
  coordinateDocumentHash as hashOf,
  createCoordinateDocument,
  type CoordinateRoute,
} from "./coordinate-document.js";
import { citationKey } from "./citations.js";
import { resolveSpecSource } from "./resolve-spec.js";
import {
  resolveAllApiCollections,
  type ResolvedApiVersion,
} from "./resolve-versions.js";

export type { CoordinatesManifest } from "../../types.js";
import type { CoordinatesManifest } from "../../types.js";

/** One published version's document: its hash now, its bytes when asked. */
export interface PublishedCoordinateDocument {
  hash: string;
  read(): string;
}

export interface CitationIndexResult {
  /** Resolves `collection:coordinate` and `collection@version:coordinate`. */
  index: CoordinateIndex;
  manifest: CoordinatesManifest;
  /** The published documents, by the file name the manifest gives each. */
  documents: Map<string, PublishedCoordinateDocument>;
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
    } else if ((node?.kind === "field" || node?.kind === "variant") && node.parent !== null) {
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

/** Where a version's pages are served. Query mode: one version-free path per
 *  operation, and a non-default version's links carry its version query. */
function routeOf(target: {
  familyPath: string;
  mountPath: string;
  versionMode: "path" | "query";
  versionParam: string;
  isDefault: boolean;
  version: string | null;
}): CoordinateRoute {
  return {
    path: target.versionMode === "query" ? target.familyPath : target.mountPath,
    query: apiVersionQuery(target),
  };
}

/** The file a version's document is published as, relative to the index. */
export function coordinateDocumentFile(collection: string, version: string | null): string {
  return version ? `coordinates/${collection}/${version}.json` : `coordinates/${collection}.json`;
}

/** Version-neutral build artifact; never embedded in request indexes. */
export interface ApiCitationSummary {
  targets: Array<{ coordinate: string; slug: string; anchor?: string }>;
  unpublished: Record<string, string>;
}

/** `schemaPages` true publishes every schema, so none is unpublished (as in 0.17). */
export function collectApiCitationSummary(
  model: ApiModel,
  schemaPages = false,
): ApiCitationSummary {
  const targets: ApiCitationSummary["targets"] = [];
  for (const { coordinate, slug } of getApiPageSlugs(model)) {
    targets.push({ coordinate, slug });
    const page = getApiPageProps(model, coordinate);
    if (page.kind === "operation") {
      for (const response of page.responses) {
        targets.push({
          coordinate: response.coordinate,
          slug,
          anchor: response.anchor,
        });
      }
    }
  }
  for (const { coordinate, slug, anchor } of getApiFieldCitations(model)) {
    targets.push({ coordinate, slug, anchor });
  }
  return {
    targets,
    unpublished: schemaPages
      ? {}
      : Object.fromEntries(pagelessSchemaCoordinates(unwrapModel(model))),
  };
}

export interface PreparedApiCitationSource {
  /** Build-only synchronous reader; retain a filename, not all version payloads. */
  read(): ApiCitationSummary;
  /** The version's document as preparation wrote it: the bytes to publish, and their hash. */
  document?: { path: string; hash: string };
}

export interface BuildCitationIndexOptions {
  preparedVersions?: ReadonlyMap<string, PreparedApiCitationSource>;
}

/** Looks up the versions read on demand as well, without listing them. */
class UnpublishedCitationMap extends Map<string, string> {
  constructor(private readonly historical: (key: string) => string | undefined) {
    super();
  }
  override get(key: string): string | undefined {
    return super.get(key) ?? this.historical(key);
  }
  override has(key: string): boolean {
    return super.has(key) || this.historical(key) !== undefined;
  }
}

/**
 * Build the citation index, the published index and each published version's
 * document, for every declared collection and version. Reuses `buildApiModel`'s
 * content-addressed cache, so a spec parsed here is not re-parsed by the render
 * path.
 *
 * A prepared version that isn't the default is read on demand: its document is
 * read when a citation first names it and one is kept at a time, so a build
 * never holds every old version. It is published from the file preparation
 * wrote, by name and hash, without being read at all.
 */
export async function buildCitationIndex(
  api: ApiSpec[] | undefined,
  root: string,
  options: BuildCitationIndexOptions = {},
): Promise<CitationIndexResult> {
  const historical = new Map<string, PreparedApiCitationSource>();
  // Bound build-time demand reads to one historical version's summary: its
  // coordinates and its diagnostics come from the same read.
  let cached: { key: string; summary: ApiCitationSummary } | undefined;
  const summaryOf = (versionKey: string, prepared: PreparedApiCitationSource) => {
    if (cached?.key !== versionKey) cached = { key: versionKey, summary: prepared.read() };
    return cached.summary;
  };
  const historicalUnpublished = (key: string) => {
    const colon = key.indexOf(":");
    if (colon < 0) return undefined;
    const versionKey = key.slice(0, colon);
    const prepared = historical.get(versionKey);
    if (!prepared) return undefined;
    const { unpublished } = summaryOf(versionKey, prepared);
    const coordinate = key.slice(colon + 1);
    return Object.hasOwn(unpublished, coordinate) ? unpublished[coordinate] : undefined;
  };
  const index = new CoordinateIndex();
  const unpublished = options.preparedVersions
    ? new UnpublishedCitationMap(historicalUnpublished)
    : new Map<string, string>();
  const documents = new Map<string, PublishedCoordinateDocument>();
  // Null-prototype maps: coordinates and collection names come from arbitrary
  // (possibly third-party) specs, so keys like `__proto__` or `constructor`
  // must land as plain own properties, never mutate a prototype.
  const manifest: CoordinatesManifest = { version: 3, collections: Object.create(null) };
  const publish = (
    target: ResolvedApiVersion,
    route: CoordinateRoute,
    document: PublishedCoordinateDocument,
  ) => {
    if (!target.publishCoordinates) return;
    const collection =
      manifest.collections[target.namespace] ??
      (manifest.collections[target.namespace] = { defaultVersion: null, versions: [] });
    if (target.isDefault) collection.defaultVersion = target.version;
    const file = coordinateDocumentFile(target.namespace, target.version);
    documents.set(file, document);
    collection.versions.push({ version: target.version, file, hash: document.hash, ...route });
  };

  for (const target of resolveAllApiCollections(api, projectMountContext(root))) {
    const route = routeOf(target);
    const prepared = options.preparedVersions?.get(target.versionKey);
    if (prepared && !target.isDefault) {
      historical.set(target.versionKey, prepared);
      const { document } = prepared;
      index.add(target.versionKey, {
        route,
        source: document
          ? () => JSON.parse(readFileSync(document.path, "utf8"))
          : () => createCoordinateDocument(summaryOf(target.versionKey, prepared).targets),
        historical: true,
        hash: document?.hash ?? target.versionKey,
      });
      if (document) {
        publish(target, route, { hash: document.hash, read: () => readFileSync(document.path, "utf8") });
      }
      continue;
    }
    let summary: ApiCitationSummary;
    if (prepared) {
      summary = prepared.read();
    } else {
      const source = await resolveSpecSource(
        {
          collection: target.namespace,
          spec: target.spec,
          label: target.label,
          mountPath: target.mountPath,
          ...targetUrlFields(target),
          requireOperationId: target.requireOperationId,
          schemaPages: target.schemaPages,
          routes: target.routes,
          samples: target.samples,
          extensions: target.extensions,
        },
        root,
      );
      summary = collectApiCitationSummary(
        await buildApiModel(source),
        target.schemaPages ?? false,
      );
    }
    for (const [coordinate, schema] of Object.entries(summary.unpublished)) {
      if (target.version)
        unpublished.set(
          citationKey(target.namespace, target.version, coordinate),
          schema,
        );
      if (target.isDefault)
        unpublished.set(
          citationKey(target.namespace, undefined, coordinate),
          schema,
        );
    }

    const document = createCoordinateDocument(summary.targets);
    const text = JSON.stringify(document);
    const hash = hashOf(text);
    const scope = { route, source: document, historical: false, hash };
    // The family default answers the unversioned key too: one document, two scopes.
    if (target.version) index.add(`${target.namespace}@${target.version}`, scope);
    if (target.isDefault) index.add(target.namespace, scope);
    publish(target, route, { hash, read: () => text });
  }

  // Stable transport bytes independent of declaration ordering.
  manifest.collections = Object.assign(Object.create(null), Object.fromEntries(
    Object.entries(manifest.collections).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  ));
  for (const collection of Object.values(manifest.collections)) {
    collection.versions.sort((a, b) => {
      const [x, y] = [a.version ?? "", b.version ?? ""];
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }
  return { index, manifest, documents, unpublished };
}

export { ingestRemoteReference } from "./coordinate-manifest.js";
