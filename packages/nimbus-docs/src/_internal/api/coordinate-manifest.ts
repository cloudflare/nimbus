/**
 * Reading another site's published coordinates: its index, then the document
 * of each version cited here. Everything from the other site is checked before
 * any of it resolves a citation, and a collection is added whole or not at all.
 */

import type { ApiReference, CoordinateDocument, CoordinatesManifest } from "../../types.js";
import { isSafeCitationPath } from "./citations.js";
import { CoordinateIndex, coordinateDocumentHash, validateCoordinateDocument } from "./coordinate-document.js";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const versionId = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
/** A document's file: a relative path of plain segments, none starting with a
 *  dot, so it can't leave the index's folder. A collection may start with "-". */
const documentFile = /^(?:[a-z0-9-][a-z0-9._-]*\/)*[a-z0-9-][a-z0-9._-]*\.json$/;
/** A version's mount path: empty, or a safe absolute path with no query, fragment or trailing slash. */
const routePath = (value: string) =>
  value === "" || (value.startsWith("/") && !value.endsWith("/") && !/[?#]/.test(value) && isSafeCitationPath(value));
/** A version's query: empty, or a safe `?…` with no fragment. */
const routeQuery = (value: string) =>
  value === "" || (value.startsWith("?") && !value.includes("#") && isSafeCitationPath(`/${value}`));

/** What went wrong with a reference, in the words the build prints. */
export class CoordinateReferenceError extends Error {}

const invalid = (detail: string): never => {
  throw new CoordinateReferenceError(
    `invalid coordinates.json: ${detail}. Rebuild the publisher with the same Nimbus release and refresh any checked-in copy`,
  );
};

/**
 * Add one reference's collection to the index. `readDocument` fetches a
 * version's file from beside the index. Returns what to warn about. Throws a
 * `CoordinateReferenceError` when the index or a cited version can't be used;
 * the index is then untouched.
 */
export async function ingestRemoteReference(
  index: CoordinateIndex,
  ref: Pick<ApiReference, "collection" | "origin" | "versions">,
  manifest: unknown,
  readDocument: (file: string) => Promise<string>,
): Promise<string[]> {
  if (record(manifest) && (manifest.version === 1 || manifest.version === 2)) {
    return invalid(
      `it is format ${manifest.version}, which this Nimbus no longer reads; the site that publishes it needs a newer Nimbus`,
    );
  }
  if (!record(manifest) || manifest.version !== 3 || !record(manifest.collections)) {
    return invalid("expected version 3 and collections");
  }
  const { collection } = ref;
  if (!Object.hasOwn(manifest.collections, collection)) {
    return [`remote manifest for "${collection}" has no such collection — citations to it will resolve to "#".`];
  }
  const entry: unknown = (manifest as unknown as CoordinatesManifest).collections[collection];
  if (!record(entry) || !Array.isArray(entry.versions)) return invalid("expected a collection with versions");
  const { defaultVersion } = entry;
  if (defaultVersion !== null && (typeof defaultVersion !== "string" || !versionId.test(defaultVersion))) {
    return invalid("invalid defaultVersion");
  }
  const published = new Map<string | null, { file: string; hash: string; path: string; query: string }>();
  for (const version of entry.versions) {
    if (
      !record(version) ||
      (version.version !== null && (typeof version.version !== "string" || !versionId.test(version.version))) ||
      typeof version.file !== "string" || !documentFile.test(version.file) ||
      typeof version.hash !== "string" || !version.hash.startsWith("sha256-") ||
      typeof version.path !== "string" || !routePath(version.path) ||
      typeof version.query !== "string" || !routeQuery(version.query)
    ) {
      return invalid("invalid version entry");
    }
    published.set(version.version, version as never);
  }

  // The default is always read; other versions only when this site says it cites them.
  const wanted: Array<string | null> = [defaultVersion ?? null];
  for (const version of ref.versions ?? []) {
    if (!published.has(version)) {
      throw new CoordinateReferenceError(
        `apiReferences lists version "${version}" of "${collection}", which that site doesn't publish` +
          ` (it publishes: ${[...published.keys()].filter((v) => v !== null).join(", ") || "no versions"})`,
      );
    }
    if (!wanted.includes(version)) wanted.push(version);
  }

  const diagnostics: string[] = [];
  const origin = ref.origin ? ref.origin.replace(/\/$/, "") : "";
  const scopes: Array<[string, Parameters<CoordinateIndex["add"]>[1]]> = [];
  for (const version of wanted) {
    const meta = published.get(version);
    if (!meta) return invalid("the default version has no entry");
    const text = await readDocument(meta.file);
    const hash = coordinateDocumentHash(text);
    if (hash !== meta.hash) {
      return invalid(`${meta.file} doesn't match the hash the index gives it; the two were published at different times`);
    }
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      return invalid(`${meta.file} is not JSON`);
    }
    const checked = validateCoordinateDocument(document);
    if ("fault" in checked) return invalid(`${meta.file}: ${checked.fault}`);
    for (const detail of checked.dropped) diagnostics.push(`remote manifest for "${collection}": ${detail}.`);
    const scope = {
      route: { path: meta.path, query: meta.query, origin },
      source: document as CoordinateDocument,
      historical: false,
      hash,
      ...(checked.duplicates.size > 0 ? { blocked: checked.duplicates } : {}),
    };
    if (version !== null) scopes.push([`${collection}@${version}`, scope]);
    if (version === (defaultVersion ?? null)) scopes.push([collection, scope]);
  }
  for (const [name, scope] of scopes) index.add(name, scope);
  return diagnostics;
}
