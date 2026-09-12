import type { CompactCoordinatesManifest, CoordinatePageGroup, CoordinatesManifest } from "../../types.js";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const versionId = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const sorted = <T>(value: Record<string, T>): Array<[string, T]> =>
  Object.keys(value).sort().map((key) => [key, value[key]!]);

/** Lossless transport packing only: no coordinate parsing or anchor regeneration. */
export function compactCoordinatesManifest(manifest: CoordinatesManifest): CompactCoordinatesManifest {
  const collections: CompactCoordinatesManifest["collections"] = Object.create(null);
  for (const [name, collection] of sorted(manifest.collections)) {
    const bare = new Map<string, Record<string, null | 0 | string>>();
    const versions = new Map<string, Map<string, Record<string, null | 0 | string>>>();
    const add = (groups: typeof bare, coordinate: string, url: string) => {
      const hash = url.indexOf("#");
      const page = hash === -1 ? url : url.slice(0, hash);
      const anchor = hash === -1 ? null : url.slice(hash + 1);
      let entries = groups.get(page);
      if (!entries) groups.set(page, entries = Object.create(null));
      entries![coordinate] = anchor === coordinate ? 0 : anchor;
    };
    for (const [coordinate, entry] of sorted(collection.entries)) {
      if (entry.url !== undefined) add(bare, coordinate, entry.url);
      for (const [version, url] of sorted(entry.versions ?? {})) {
        let groups = versions.get(version);
        if (!groups) versions.set(version, groups = new Map());
        add(groups, coordinate, url);
      }
    }
    const pages = (groups: typeof bare): CoordinatePageGroup[] =>
      [...groups.keys()].sort().map((url) => ({ url, entries: groups.get(url)! }));
    collections[name] = {
      defaultVersion: collection.defaultVersion,
      pages: pages(bare),
      ...(versions.size ? { versions: Object.fromEntries(
        [...versions.keys()].sort().map((version) => [version, pages(versions.get(version)!)]),
      ) } : {}),
    };
  }
  return { version: 2, collections };
}

/** Validate one selected collection before the caller mutates its citation index. */
export function expandCompactCollection(value: unknown): {
  collection: CoordinatesManifest["collections"][string]; diagnostics: string[];
} {
  const fail = (detail: string): never => { throw new Error(`invalid v2 coordinates.json: ${detail}`); };
  if (!record(value)) return fail("expected a collection record");
  const { defaultVersion, pages, versions } = value;
  if (defaultVersion !== null && (typeof defaultVersion !== "string" || !versionId.test(defaultVersion))) {
    return fail("invalid defaultVersion");
  }
  const entries: CoordinatesManifest["collections"][string]["entries"] = Object.create(null);
  const diagnostics: string[] = [];
  const warn = (detail: string) => { diagnostics.push(`remote v2 manifest: ${detail}.`); };
  const expand = (groups: unknown, version?: string) => {
    if (!Array.isArray(groups)) return fail("expected page groups");
    const seen = new Set<string>();
    for (const group of groups) {
      if (!record(group) || typeof group.url !== "string" || group.url.includes("#") || !record(group.entries)) {
        warn("dropped invalid page group");
        continue;
      }
      for (const [coordinate, marker] of Object.entries(group.entries)) {
        if (seen.has(coordinate)) {
          const previous = entries[coordinate];
          if (previous) {
            if (version === undefined) delete previous.url;
            else if (previous.versions) delete previous.versions[version];
          }
          warn(`dropped duplicate coordinate ${JSON.stringify(coordinate)}`);
          continue;
        }
        seen.add(coordinate);
        if (marker !== null && marker !== 0 && typeof marker !== "string") {
          warn(`dropped invalid fragment marker for ${JSON.stringify(coordinate)}`);
          continue;
        }
        const url = group.url + (marker === null ? "" : `#${marker === 0 ? coordinate : marker}`);
        const entry = entries[coordinate] ?? (entries[coordinate] = {});
        if (version === undefined) entry.url = url;
        else (entry.versions ??= Object.create(null))[version] = url;
      }
    }
  };
  expand(pages);
  if (versions !== undefined) {
    if (!record(versions)) return fail("invalid versions record");
    for (const [version, groups] of Object.entries(versions)) {
      if (!versionId.test(version)) {
        warn(`dropped invalid version id ${JSON.stringify(version)}`);
        continue;
      }
      expand(groups, version);
    }
  }
  return { collection: { defaultVersion, entries }, diagnostics };
}
