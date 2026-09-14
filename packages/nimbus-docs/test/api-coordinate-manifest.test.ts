import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCitationIndex, ingestRemoteManifest } from "../src/_internal/api/citation-index.ts";
import { createPageGroups } from "../src/_internal/api/coordinate-manifest.ts";
import { ingestApiReferences } from "../src/_internal/api/ingest-references.ts";
import type { ApiSpec, CoordinatePageGroup, CoordinatesManifest } from "../src/types.ts";

const spec = fileURLToPath(new URL("./fixtures/api/smallco.yaml", import.meta.url));
const decode = (manifest: CoordinatesManifest, origin?: string) => {
  const index = new Map<string, string>();
  for (const name of Object.keys(manifest.collections)) {
    assert.deepEqual(ingestRemoteManifest(index, name, manifest, origin), []);
  }
  return index;
};

test("empty API declarations publish an empty v2 manifest", async () => {
  assert.deepEqual((await buildCitationIndex(undefined, ".")).manifest,
    { version: 2, collections: Object.create(null) });
});

test("producer bytes are independent of collection and version declaration order", async () => {
  const api: ApiSpec[] = ["z", "svc"].map(collection => ({
    collection, versions: [{ version: "v2", default: true, spec }, { version: "v1", spec }],
  }));
  const reversed = [...api].reverse().map(value => ({ ...value, versions: [...value.versions!].reverse() }));
  assert.equal(JSON.stringify((await buildCitationIndex(api, ".")).manifest),
    JSON.stringify((await buildCitationIndex(reversed, ".")).manifest));
});

for (const versioned of [false, true]) {
  test(`compact transport preserves actual ${versioned ? "versioned" : "unversioned"} producer citations`, async () => {
    const api: ApiSpec[] = [versioned
      ? { collection: "svc", versions: [{ version: "v2", default: true, spec }, { version: "v1", spec }] }
      : { collection: "svc", spec }];
    const { manifest, index } = await buildCitationIndex(api, ".");
    const compact = JSON.parse(JSON.stringify(manifest));
    assert.deepEqual(decode(compact), index);
    assert.deepEqual(decode(compact, "https://example.com/"), decode(manifest, "https://example.com/"));
    assert.equal(compact.collections.svc.defaultVersion, versioned ? "v2" : null);
    assert.equal(decode(compact).get("svc:create.response.200"), index.get("svc:create.response.200"));
  });
}

test("opaque coordinates and literal fragments survive JSON transport without normalization", () => {
  const targets = [
    { coordinate: "root", url: "/api?mode=a%2Fb" },
    { coordinate: "empty", url: "/api?mode=a%2Fb#" },
    { coordinate: "a:b.雪", url: "/api?a=1#different#second" },
    { coordinate: "__proto__", url: "/api#__proto__" },
    { coordinate: "encoded", url: "/api#%E9%9B%AA%2Fvalue" },
    { coordinate: "Case", url: "/api#Case" },
    { coordinate: "case", url: "/api#case" },
    { coordinate: "field@revision", url: "/api#field@revision" },
  ];
  const manifest: CoordinatesManifest = { version: 2, collections: { svc: {
    defaultVersion: "v2", pages: createPageGroups(targets),
    versions: { v1: createPageGroups([{ coordinate: "constructor", url: "/v1/api#constructor" }]) },
  } } };
  for (const { coordinate, url } of targets) assert.equal(decode(manifest).get("svc:" + coordinate), url);
  const compact = manifest;
  assert.deepEqual(decode(JSON.parse(JSON.stringify(compact))), decode(manifest));
  assert.equal(decode(compact).has("svc:constructor"), false, "version-only coordinates must not gain bare aliases");
  assert.equal(decode(compact).get("svc:empty"), "/api?mode=a%2Fb#");
  assert.equal(decode(compact).get("svc:__proto__"), "/api#__proto__");
  assert.equal(decode(compact).get("svc:Case"), "/api#Case");
  assert.equal(decode(compact).get("svc:case"), "/api#case");
  assert.equal(decode(compact).get("svc:field@revision"), "/api#field@revision");
  assert.equal(Object.getPrototypeOf(compact.collections.svc!.pages.find(p => Object.hasOwn(p.entries, "__proto__"))!.entries), null);
});

test("actual producer preserves non-api collection and version mount paths", async () => {
  // ApiSpec exposes collection/version, not an independently configurable mountPath.
  const { manifest, index } = await buildCitationIndex([{ collection: "reference", versions: [
    { version: "v2", default: true, spec }, { version: "v1", spec },
  ] }], ".");
  const compactIndex = decode(JSON.parse(JSON.stringify(manifest)));
  assert.deepEqual(compactIndex, index);
  assert.equal(compactIndex.get("reference:reference"), "/reference");
  assert.equal(compactIndex.get("reference@v1:reference"), "/reference/v1");
  assert.match(compactIndex.get("reference@v1:create.response.200")!, /^\/reference\/v1\/.*#response-200$/);
});

test("missing collections warn without modifying the index", () => {
  const index = new Map([["existing:page", "/existing"]]);
  assert.equal(ingestRemoteManifest(index, "missing", { version: 2, collections: {} }).length, 1);
  assert.deepEqual(index, new Map([["existing:page", "/existing"]]));
});

test("a local malformed compact entry warns while preserving a valid sibling", async () => {
  const root = mkdtempSync(join(tmpdir(), "nimbus-compact-local-entry-"));
  try {
    writeFileSync(join(root, "coordinates.json"), JSON.stringify({ version: 2, collections: {
      svc: { defaultVersion: null, pages: [{ url: "/api", entries: { good: 0, bad: false } }] },
    } }));
    const warnings: string[] = [];
    const index = new Map<string, string>();
    await ingestApiReferences([{ collection: "svc", manifest: "coordinates.json" }], index, root, {
      warn: message => warnings.push(message),
    });
    assert.deepEqual(index, new Map([["svc:good", "/api#good"]]));
    assert.ok(warnings.some(message => /fragment marker/.test(message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packing is deterministic and does not mutate its input", () => {
  const targets = [{ coordinate: "b", url: "/b#b" }, { coordinate: "a", url: "/a#" }];
  const before = JSON.stringify(targets);
  assert.equal(JSON.stringify(createPageGroups(targets)), JSON.stringify(createPageGroups([...targets].reverse())));
  assert.equal(JSON.stringify(targets), before);
});

test("malformed records and reconstructed unsafe URLs are dropped without losing valid neighbors", () => {
  const manifest = { version: 2, collections: { svc: { defaultVersion: null, pages: [
    { url: "/api", entries: { good: 0, bad: false, injection: "x\nunsafe" } },
    { url: "//evil.example", entries: { external: null } },
    { url: "/api#unexpected", entries: { hashBase: null } },
    { url: "/bad", entries: [] },
    null,
  ], versions: { "bad@version": [{ url: "/bad", entries: { x: null } }], v1: [{ url: "/v1", entries: { good: 0 } }] } } } };
  const index = new Map<string, string>();
  const warnings = ingestRemoteManifest(index, "svc", manifest as unknown as CoordinatesManifest);
  assert.ok(warnings.length > 0);
  assert.deepEqual(index, new Map([["svc:good", "/api#good"], ["svc@v1:good", "/v1#good"]]));
});

test("duplicate coordinates are rejected per namespace, regardless of group order", () => {
  const pages: CoordinatePageGroup[] = [{ url: "/one", entries: { duplicate: null, kept: 0 } }, { url: "/two", entries: { duplicate: 0 } }];
  for (const groups of [pages, [...pages].reverse()]) {
    const manifest: CoordinatesManifest = { version: 2, collections: { svc: { defaultVersion: "v2", pages: groups, versions: {
      v1: [{ url: "/v1", entries: { duplicate: null } }],
      v2: [{ url: "/v2/a", entries: { other: null } }, { url: "/v2/b", entries: { other: null } }],
    } } } };
    const index = new Map<string, string>();
    assert.ok(ingestRemoteManifest(index, "svc", manifest).length > 0);
    assert.deepEqual(index, new Map([["svc:kept", "/one#kept"], ["svc@v1:duplicate", "/v1"]]));
  }
});

test("collection-shape failures are actionable locally and best-effort remotely, without partial ingestion", async () => {
  const root = mkdtempSync(join(tmpdir(), "nimbus-compact-references-"));
  const realFetch = globalThis.fetch;
  try {
    for (const collection of [
      { defaultVersion: null, pages: {} },
      { defaultVersion: false, pages: [] },
      { defaultVersion: null, pages: [{ url: "/valid", entries: { good: null } }], versions: [] },
    ]) {
      const raw = { version: 2, collections: { svc: collection } };
      writeFileSync(join(root, "coordinates.json"), JSON.stringify(raw));
      const index = new Map<string, string>();
      const warnings: string[] = [];
      const logger = { warn: (message: string) => warnings.push(message) };
      await assert.rejects(ingestApiReferences([{ collection: "svc", manifest: "coordinates.json" }], index, root, logger), /coordinates\.json/);
      assert.equal(index.size, 0);
      globalThis.fetch = async () => new Response(JSON.stringify(raw));
      await ingestApiReferences([{ collection: "svc", manifest: "https://example.com/coordinates.json" }], index, root, logger);
      assert.equal(index.size, 0);
      assert.ok(warnings.length > 0);
    }
  } finally {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("v1 is rejected locally and warned remotely without losing existing citations", async () => {
  const root = mkdtempSync(join(tmpdir(), "nimbus-v1-rejection-"));
  const realFetch = globalThis.fetch;
  try {
    const raw = { version: 1, collections: { svc: { defaultVersion: null, entries: { old: { url: "/old" } } } } };
    writeFileSync(join(root, "coordinates.json"), JSON.stringify(raw));
    const index = new Map([["existing:page", "/existing"]]);
    const warnings: string[] = [];
    const logger = { warn: (message: string) => warnings.push(message) };
    await assert.rejects(ingestApiReferences([{ collection: "svc", manifest: "coordinates.json" }], index, root, logger), /Rebuild the publisher.*v1 is no longer supported/);
    globalThis.fetch = async () => new Response(JSON.stringify(raw));
    await ingestApiReferences([{ collection: "svc", manifest: "https://example.com/coordinates.json" }], index, root, logger);
    assert.match(warnings[0]!, /Rebuild the publisher.*v1 is no longer supported/);
    assert.deepEqual(index, new Map([["existing:page", "/existing"]]));
    assert.throws(() => ingestRemoteManifest(index, "svc", raw as unknown as CoordinatesManifest), /v1 is no longer supported/);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTPS ingestion preserves trusted-origin targets and existing local citations", async () => {
  const { manifest, index: expected } = await buildCitationIndex([{ collection: "svc", versions: [
    { version: "v2", default: true, spec }, { version: "v1", spec },
  ] }], ".");
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify(manifest));
    const index = new Map([["local:keep", "/keep"]]);
    const warnings: string[] = [];
    await ingestApiReferences([{ collection: "svc", manifest: "https://example.com/coordinates.json", origin: "https://example.com/docs/" }], index, ".", { warn: message => warnings.push(message) });
    assert.deepEqual(warnings, []);
    assert.deepEqual(index, new Map([["local:keep", "/keep"], ...[...expected].map(([key, url]): [string, string] => [key, "https://example.com/docs" + url])]));
  } finally { globalThis.fetch = realFetch; }
});
