import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCitationIndex, ingestRemoteManifest } from "../src/_internal/api/citation-index.ts";
import { compactCoordinatesManifest } from "../src/_internal/api/compact-coordinates.ts";
import { ingestApiReferences } from "../src/_internal/api/ingest-references.ts";
import type { ApiSpec, CompactCoordinatesManifest, CoordinatePageGroup, CoordinatesManifest } from "../src/types.ts";

const spec = fileURLToPath(new URL("./fixtures/api/smallco.yaml", import.meta.url));
const decode = (manifest: CoordinatesManifest | CompactCoordinatesManifest, origin?: string) => {
  const index = new Map<string, string>();
  for (const name of Object.keys(manifest.collections)) {
    assert.deepEqual(ingestRemoteManifest(index, name, manifest, origin), []);
  }
  return index;
};

for (const versioned of [false, true]) {
  test(`compact transport preserves actual ${versioned ? "versioned" : "unversioned"} producer citations`, async () => {
    const api: ApiSpec[] = [versioned
      ? { collection: "svc", versions: [{ version: "v2", default: true, spec }, { version: "v1", spec }] }
      : { collection: "svc", spec }];
    const { manifest, index } = await buildCitationIndex(api, ".");
    const compact = JSON.parse(JSON.stringify(compactCoordinatesManifest(manifest)));
    assert.deepEqual(decode(compact), index);
    assert.deepEqual(decode(compact, "https://example.com/"), decode(manifest, "https://example.com/"));
    assert.equal(compact.collections.svc.defaultVersion, versioned ? "v2" : null);
    assert.equal(decode(compact).get("svc:create.response.200"), index.get("svc:create.response.200"));
  });
}

test("opaque coordinates and literal fragments survive JSON transport without normalization", () => {
  const entries = Object.fromEntries([
    ["root", { url: "/api?mode=a%2Fb" }],
    ["empty", { url: "/api?mode=a%2Fb#" }],
    ["a:b.雪", { url: "/api?a=1#different#second" }],
    ["__proto__", { url: "/api#__proto__" }],
    ["constructor", { versions: { v1: "/v1/api#constructor" } }],
    ["encoded", { url: "/api#%E9%9B%AA%2Fvalue" }],
    ["Case", { url: "/api#Case" }],
    ["case", { url: "/api#case" }],
    ["field@revision", { url: "/api#field@revision" }],
  ]);
  const manifest: CoordinatesManifest = { version: 1, collections: { svc: { defaultVersion: "v2", entries } } };
  const compact = compactCoordinatesManifest(manifest);
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
  const compactIndex = decode(JSON.parse(JSON.stringify(compactCoordinatesManifest(manifest))));
  assert.deepEqual(compactIndex, index);
  assert.equal(compactIndex.get("reference:reference"), "/reference");
  assert.equal(compactIndex.get("reference@v1:reference"), "/reference/v1");
  assert.match(compactIndex.get("reference@v1:create.response.200")!, /^\/reference\/v1\/.*#response-200$/);
});

test("missing collections warn consistently for old and compact manifests", () => {
  const index = new Map<string, string>([["existing:page", "/existing"]]);
  const oldWarnings = ingestRemoteManifest(index, "missing", { version: 1, collections: {} });
  const compactWarnings = ingestRemoteManifest(index, "missing", { version: 2, collections: {} });
  assert.ok(oldWarnings.length > 0);
  assert.deepEqual(compactWarnings, oldWarnings);
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

test("packing produces identical bytes independently of input insertion order", () => {
  const collection = (reverse: boolean) => ({ defaultVersion: "v2", entries: Object.fromEntries(
    (reverse ? ["b", "a"] : ["a", "b"]).map(key => [key, {
      url: `/api/${key}#${key}`,
      versions: Object.fromEntries((reverse ? ["v2", "v1"] : ["v1", "v2"]).map(v => [v, `/${v}/${key}#${key}`])),
    }]),
  ) });
  const manifest = (reverse: boolean): CoordinatesManifest => ({ version: 1, collections: Object.fromEntries(
    (reverse ? ["z", "svc"] : ["svc", "z"]).map(name => [name, collection(reverse)]),
  ) });
  const before = JSON.stringify(manifest(false));
  assert.equal(JSON.stringify(compactCoordinatesManifest(manifest(false))), JSON.stringify(compactCoordinatesManifest(manifest(true))));
  const input = manifest(false);
  compactCoordinatesManifest(input);
  assert.equal(JSON.stringify(input), before, "packing must not mutate the native v1 helper's result");
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
  const warnings = ingestRemoteManifest(index, "svc", manifest as unknown as CompactCoordinatesManifest);
  assert.ok(warnings.length > 0);
  assert.deepEqual(index, new Map([["svc:good", "/api#good"], ["svc@v1:good", "/v1#good"]]));
});

test("duplicate coordinates are rejected per namespace, regardless of group order", () => {
  const pages: CoordinatePageGroup[] = [{ url: "/one", entries: { duplicate: null, kept: 0 } }, { url: "/two", entries: { duplicate: 0 } }];
  for (const groups of [pages, [...pages].reverse()]) {
    const manifest: CompactCoordinatesManifest = { version: 2, collections: { svc: { defaultVersion: "v2", pages: groups, versions: {
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

test("HTTPS ingestion accepts v1 and v2 with the same trusted-origin targets", async () => {
  const manifest: CoordinatesManifest = { version: 1, collections: {
    reference: { defaultVersion: "v2", entries: {
      operation: { url: "/reference/create", versions: { v1: "/reference/v1/create" } },
      response: { url: "/reference/create#response-200" },
    } },
  } };
  const realFetch = globalThis.fetch;
  try {
    for (const value of [manifest, compactCoordinatesManifest(manifest)]) {
      globalThis.fetch = async () => new Response(JSON.stringify(value));
      const index = new Map<string, string>([["local:keep", "/keep"]]);
      const warnings: string[] = [];
      await ingestApiReferences([{ collection: "reference", manifest: "https://publisher.example/coordinates.json", origin: "https://publisher.example/docs" }], index, ".", { warn: message => warnings.push(message) });
      assert.deepEqual(warnings, []);
      assert.deepEqual(index, new Map([
        ["local:keep", "/keep"],
        ["reference:operation", "https://publisher.example/docs/reference/create"],
        ["reference@v1:operation", "https://publisher.example/docs/reference/v1/create"],
        ["reference:response", "https://publisher.example/docs/reference/create#response-200"],
      ]));
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
