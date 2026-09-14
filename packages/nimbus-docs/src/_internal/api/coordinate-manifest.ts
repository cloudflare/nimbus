import type { CoordinatePageGroup, CoordinatesManifest } from "../../types.js";
import { citationKey, isSafeCitationPath } from "./citations.js";

/** Pack literal targets without parsing coordinates or regenerating anchors. */
export function createPageGroups(targets: Array<{ coordinate: string; url: string }>): CoordinatePageGroup[] {
  const groups = new Map<string, Record<string, null | 0 | string>>();
  for (const { coordinate, url } of [...targets].sort((a, b) =>
    a.coordinate < b.coordinate ? -1 : a.coordinate > b.coordinate ? 1 : 0)) {
    const hash = url.indexOf("#");
    const page = hash === -1 ? url : url.slice(0, hash);
    const fragment = hash === -1 ? null : url.slice(hash + 1);
    let entries = groups.get(page);
    if (!entries) groups.set(page, entries = Object.create(null));
    entries![coordinate] = fragment === coordinate ? 0 : fragment;
  }
  return [...groups.keys()].sort().map((url) => ({ url, entries: groups.get(url)! }));
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const versionId = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/** Validate the selected collection completely before publishing any targets. */
export function ingestRemoteManifest(
  index: Map<string, string>, collection: string, manifest: CoordinatesManifest, origin?: string,
): string[] {
  const fail = (detail: string): never => {
    throw new Error(`invalid coordinates.json: ${detail}. Rebuild the publisher with the same Nimbus release and refresh any checked-in manifest`);
  };
  if (!record(manifest) || manifest.version !== 2 || !record(manifest.collections)) {
    return fail("expected version 2 and collections; v1 is no longer supported");
  }
  if (!Object.hasOwn(manifest.collections, collection)) {
    return [`remote manifest for "${collection}" has no such collection — citations to it will resolve to "#".`];
  }
  const value: unknown = manifest.collections[collection];
  if (!record(value)) return fail("expected a collection record");
  const { defaultVersion, pages, versions } = value;
  if (defaultVersion !== null && (typeof defaultVersion !== "string" || !versionId.test(defaultVersion))) {
    return fail("invalid defaultVersion");
  }
  const diagnostics: string[] = [];
  const pending = new Map<string, string>();
  const warn = (detail: string) => { diagnostics.push(`remote manifest for "${collection}": ${detail}.`); };
  const trustedOrigin = origin ? origin.replace(/\/$/, "") : "";
  const ingest = (groups: unknown, version?: string) => {
    if (!Array.isArray(groups)) return fail("expected page groups");
    const seen = new Set<string>();
    for (const group of groups) {
      if (!record(group) || typeof group.url !== "string" || group.url.includes("#") || !record(group.entries)) {
        warn("dropped invalid page group");
        continue;
      }
      for (const [coordinate, marker] of Object.entries(group.entries)) {
        const key = citationKey(collection, version, coordinate);
        if (seen.has(coordinate)) {
          pending.delete(key);
          warn(`dropped duplicate coordinate ${JSON.stringify(coordinate)}`);
          continue;
        }
        seen.add(coordinate);
        if (marker !== null && marker !== 0 && typeof marker !== "string") {
          warn(`dropped invalid fragment marker for ${JSON.stringify(coordinate)}`);
          continue;
        }
        const url = group.url + (marker === null ? "" : `#${marker === 0 ? coordinate : marker}`);
        if (!isSafeCitationPath(url)) {
          warn(`dropped unsafe path ${JSON.stringify(url)}`);
          continue;
        }
        pending.set(key, trustedOrigin + url);
      }
    }
  };
  ingest(pages);
  if (versions !== undefined) {
    if (!record(versions)) return fail("invalid versions record");
    for (const [version, groups] of Object.entries(versions)) {
      if (!versionId.test(version)) {
        warn(`dropped invalid version id ${JSON.stringify(version)}`);
        continue;
      }
      ingest(groups, version);
    }
  }
  for (const [key, url] of pending) index.set(key, url);
  return diagnostics;
}
