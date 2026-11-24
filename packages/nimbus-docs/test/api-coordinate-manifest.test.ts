import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCitationIndex, type CitationIndexResult } from "../src/_internal/api/citation-index.ts";
import {
  CoordinateIndex,
  createCoordinateDocument,
  validateCoordinateDocument,
} from "../src/_internal/api/coordinate-document.ts";
import { ingestRemoteReference } from "../src/_internal/api/coordinate-manifest.ts";
import { ingestApiReferences } from "../src/_internal/api/ingest-references.ts";
import type { ApiSpec, CoordinateDocument, CoordinatesManifest } from "../src/types.ts";

const spec = fileURLToPath(new URL("./fixtures/api/smallco.yaml", import.meta.url));
const versioned: ApiSpec[] = [
  { collection: "svc", versions: [{ version: "v2", default: true, spec }, { version: "v1", spec }] },
];
const hashOf = (text: string) => `sha256-${createHash("sha256").update(text).digest("base64")}`;
const none = { warn: () => {} };

/** What a site publishes, as the files another site would read. */
function published({ manifest, documents }: CitationIndexResult): Record<string, string> {
  const files: Record<string, string> = { "coordinates.json": JSON.stringify(manifest) };
  for (const [file, document] of documents) files[file] = document.read();
  return files;
}

function writeFolder(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

/** One document under one route, as an index. */
function indexOf(document: CoordinateDocument, route = { path: "/api", query: "" }): CoordinateIndex {
  const index = new CoordinateIndex();
  index.add("svc", { route, source: document, historical: false, hash: "x" });
  return index;
}

test("empty API declarations publish an empty index and no documents", async () => {
  const { manifest, documents, index } = await buildCitationIndex(undefined, ".");
  assert.deepEqual(manifest, { version: 3, collections: Object.create(null) });
  assert.equal(documents.size, 0);
  assert.equal(index.size, 0);
});

test("the index and every document are the same bytes whatever order the config declares", async () => {
  const api: ApiSpec[] = ["z", "svc"].map((collection) => ({
    collection, versions: [{ version: "v2", default: true, spec }, { version: "v1", spec }],
  }));
  const reversed = [...api].reverse().map((value) => ({ ...value, versions: [...value.versions!].reverse() }));
  assert.deepEqual(published(await buildCitationIndex(api, ".")), published(await buildCitationIndex(reversed, ".")));
});

test("the index names one document per version and stores the default once", async () => {
  const { manifest, documents } = await buildCitationIndex(versioned, ".");
  assert.equal(manifest.collections.svc!.defaultVersion, "v2");
  assert.deepEqual(manifest.collections.svc!.versions.map(({ version, file, path, query }) => ({ version, file, path, query })), [
    { version: "v1", file: "coordinates/svc/v1.json", path: "/svc/v1", query: "" },
    { version: "v2", file: "coordinates/svc/v2.json", path: "/svc", query: "" },
  ]);
  assert.deepEqual([...documents.keys()].sort(), ["coordinates/svc/v1.json", "coordinates/svc/v2.json"]);
  for (const { file, hash } of manifest.collections.svc!.versions) assert.equal(hashOf(documents.get(file)!.read()), hash);
  // The index is small whatever the API's size: it holds no coordinate.
  assert.ok(JSON.stringify(manifest).length < 600);
  const unversioned = await buildCitationIndex([{ collection: "svc", spec }], ".");
  assert.deepEqual(unversioned.manifest.collections.svc!.versions.map(({ version, file }) => ({ version, file })), [
    { version: null, file: "coordinates/svc.json" },
  ]);
});

test("a document holds slugs and anchors, never where its version is served", async () => {
  const asDefault = await buildCitationIndex(versioned, ".");
  const asOlder = await buildCitationIndex([
    { collection: "svc", versions: [{ version: "v3", default: true, spec }, { version: "v2", spec }] },
  ], ".");
  // v2's document is the same bytes whether v2 is the default or not; only its route moves.
  assert.equal(asDefault.documents.get("coordinates/svc/v2.json")!.read(), asOlder.documents.get("coordinates/svc/v2.json")!.read());
  assert.equal(asDefault.index.get("svc@v2:create"), "/svc/charges/create");
  assert.equal(asOlder.index.get("svc@v2:create"), "/svc/v2/charges/create");
  assert.equal(asOlder.index.get("svc:create"), "/svc/charges/create");
});

for (const withVersions of [false, true]) {
  test(`another site resolves every ${withVersions ? "versioned" : "unversioned"} citation as the publisher does`, async () => {
    const api: ApiSpec[] = withVersions ? versioned : [{ collection: "svc", spec }];
    const result = await buildCitationIndex(api, ".");
    const files = published(result);
    const remote = new CoordinateIndex();
    assert.deepEqual(
      await ingestRemoteReference(remote, { collection: "svc", versions: withVersions ? ["v1"] : undefined },
        JSON.parse(files["coordinates.json"]!), async (file) => files[file]!),
      [],
    );
    assert.ok(result.index.size > 20);
    assert.deepEqual([...remote].sort(), [...result.index].sort());
    assert.match(remote.get("svc:create.response.200")!, /#response-200$/);
  });
}

test("only the default version is read unless the reference lists others", async () => {
  const files = published(await buildCitationIndex(versioned, "."));
  const read: string[] = [];
  const index = new CoordinateIndex();
  await ingestRemoteReference(index, { collection: "svc" }, JSON.parse(files["coordinates.json"]!), async (file) => {
    read.push(file);
    return files[file]!;
  });
  assert.deepEqual(read, ["coordinates/svc/v2.json"]);
  assert.equal(index.get("svc:create"), "/svc/charges/create");
  assert.equal(index.get("svc@v2:create"), "/svc/charges/create");
  assert.equal(index.get("svc@v1:create"), undefined);
  assert.equal(index.hasCollection("svc"), true);
  await assert.rejects(
    ingestRemoteReference(new CoordinateIndex(), { collection: "svc", versions: ["v9"] },
      JSON.parse(files["coordinates.json"]!), async (file) => files[file]!),
    /lists version "v9" of "svc", which that site doesn't publish \(it publishes: v1, v2\)/,
  );
});

test("coordinates are opaque: dots in a name, a page id that is another's prefix, and odd keys all resolve", () => {
  const document = createCoordinateDocument([
    { coordinate: "a", slug: "a" },
    { coordinate: "a.b", slug: "a-b" },
    // A property literally named "b.x" under operation a: there is no "a.b" field.
    { coordinate: "a.b.x", slug: "a", anchor: "a.b.x" },
    { coordinate: "a.b.y", slug: "a-b", anchor: "y" },
    { coordinate: "a.雪:z", slug: "a", anchor: "" },
    { coordinate: "a.Case", slug: "a", anchor: "a.Case" },
    { coordinate: "a.case", slug: "a", anchor: "a.case" },
    { coordinate: "a.body", slug: "a" },
    { coordinate: "__proto__", slug: "proto" },
    { coordinate: "__proto__.constructor", slug: "proto", anchor: "c" },
    { coordinate: "stray", slug: "a", anchor: "stray#second" },
  ]);
  const index = indexOf(JSON.parse(JSON.stringify(document)));
  assert.equal(index.get("svc:a"), "/api/a");
  assert.equal(index.get("svc:a.b"), "/api/a-b");
  assert.equal(index.get("svc:a.b.x"), "/api/a#a.b.x");
  assert.equal(index.get("svc:a.b.y"), "/api/a-b#y");
  assert.equal(index.get("svc:a.雪:z"), "/api/a#");
  assert.equal(index.get("svc:a.Case"), "/api/a#a.Case");
  assert.equal(index.get("svc:a.case"), "/api/a#a.case");
  assert.equal(index.get("svc:a.body"), "/api/a");
  assert.equal(index.get("svc:__proto__"), "/api/proto");
  assert.equal(index.get("svc:__proto__.constructor"), "/api/proto#c");
  assert.equal(index.get("svc:stray"), "/api/a#stray#second");
  // A prefix of a real coordinate is not one, and neither is an object's own machinery.
  for (const key of ["svc:a.b.", "svc:a.", "svc:a.constructor", "svc:a.__proto__", "svc:toString", "svc:"]) {
    assert.equal(index.get(key), undefined, key);
  }
  assert.equal(index.size, 11);
  assert.deepEqual([...index.keys()].sort(), [...index.candidates("svc:anything")].sort());
});

test("packing is deterministic, keeps the first of a repeated coordinate, and leaves its input alone", () => {
  const targets = [
    { coordinate: "b", slug: "b" },
    { coordinate: "a", slug: "a" },
    { coordinate: "a.f", slug: "a", anchor: "one" },
    { coordinate: "a.f", slug: "a", anchor: "two" },
  ];
  const before = JSON.stringify(targets);
  const document = createCoordinateDocument(targets);
  assert.deepEqual(document, { version: 3, pages: [["a", "a", { ".f": "one" }], ["b", "b", {}]] });
  assert.equal(JSON.stringify(targets), before);
  assert.deepEqual(validateCoordinateDocument(JSON.parse(JSON.stringify(document))), { dropped: [], duplicates: new Set() });
});

test("a link that would be unsafe is never handed out", () => {
  const index = indexOf({ version: 3, pages: [
    ["ok", "ok", { ".f": "x\nunsafe", ".g": 0 }],
    ["//evil.example", "evil", {}],
    ["java script:alert(1)", "script", {}],
  ] });
  assert.equal(index.get("svc:ok"), "/api/ok");
  assert.equal(index.get("svc:ok.g"), "/api/ok#ok.g");
  assert.equal(index.get("svc:ok.f"), undefined);
  assert.equal(index.get("svc:script"), undefined);
  assert.equal(indexOf({ version: 3, pages: [["x", "x", {}]] }, { path: "//evil.example", query: "" }).get("svc:x"), undefined);
});

test("a document from elsewhere is checked whole, and a coordinate listed twice answers for neither", async () => {
  for (const [document, fault] of [
    [{ version: 2, pages: [] }, /version 3/],
    [{ version: 3, pages: {} }, /version 3/],
    [{ version: 3, pages: [["a", "a"]] }, /invalid page entry/],
    [{ version: 3, pages: [["a", "a", { ".f": false }]] }, /invalid coordinate entry/],
    [{ version: 3, pages: [["a", "a", { f: 0 }]] }, /invalid coordinate entry/],
    [{ version: 3, pages: [], other: { x: ["a"] } }, /invalid other entry/],
  ] as const) {
    const checked = validateCoordinateDocument(document);
    assert.ok("fault" in checked && fault.test(checked.fault), JSON.stringify(document));
  }
  const document = { version: 3, pages: [["one", "dup", { ".kept": 0 }], ["two", "dup", { ".also": 0 }], ["a", "a", { ".b.c": 0 }], ["a-b", "a.b", { ".c": 0 }]] };
  const text = JSON.stringify(document);
  const manifest: CoordinatesManifest = { version: 3, collections: { svc: { defaultVersion: null, versions: [
    { version: null, file: "coordinates/svc.json", hash: hashOf(text), path: "/api", query: "" },
  ] } } };
  const index = new CoordinateIndex();
  const warnings = await ingestRemoteReference(index, { collection: "svc" }, manifest, async () => text);
  assert.equal(warnings.length, 2);
  // "dup" and "a.b.c" are each claimed twice; every coordinate claimed once still resolves.
  const expected = [["svc:a", "/api/a"], ["svc:a.b", "/api/a-b"], ["svc:dup.also", "/api/two#dup.also"], ["svc:dup.kept", "/api/one#dup.kept"]];
  assert.deepEqual([...index].sort(), expected);
  for (const key of ["svc:dup", "svc:a.b.c"]) assert.equal(index.get(key), undefined, key);
  // The build's own module resolves the same, duplicates still refused.
  const restored = CoordinateIndex.fromPayload(JSON.parse(JSON.stringify(index.toPayload())));
  assert.deepEqual([...restored].sort(), expected);
  for (const key of ["svc:dup", "svc:a.b.c"]) assert.equal(restored.get(key), undefined, key);
});

test("a collection whose name starts with a dash is read back from the file it is published as", async () => {
  const result = await buildCitationIndex([{ collection: "-svc", spec }], ".");
  const files = published(result);
  assert.ok("coordinates/-svc.json" in files);
  const index = new CoordinateIndex();
  assert.deepEqual(await ingestRemoteReference(index, { collection: "-svc" }, JSON.parse(files["coordinates.json"]!), async (file) => files[file]!), []);
  assert.deepEqual([...index].sort(), [...result.index].sort());
});

test("a version served under any path Nimbus itself would publish is accepted", async () => {
  const text = JSON.stringify({ version: 3, pages: [["op", "op", {}]] });
  const entry = { version: null, file: "coordinates/svc.json", hash: hashOf(text) };
  for (const [path, query, url] of [
    ["/api+sdk", "", "/api+sdk/op"],
    ["/réf/v1", "", "/réf/v1/op"],
    ["", "?version=2026-11-30.air", "/op?version=2026-11-30.air"],
    ["/a", "?api-version=v1%2Fx", "/a/op?api-version=v1%2Fx"],
  ] as const) {
    const index = new CoordinateIndex();
    const manifest = { version: 3, collections: { svc: { defaultVersion: null, versions: [{ ...entry, path, query }] } } };
    assert.deepEqual(await ingestRemoteReference(index, { collection: "svc" }, manifest, async () => text), []);
    assert.equal(index.get("svc:op"), url);
  }
  for (const [path, query] of [["/api/", ""], ["api", ""], ["/a b", ""], ["/a\\b", ""], ["/a", "version=1"], ["/a", "?v=1#x"], ["/a", "? v=1"]] as const) {
    const manifest = { version: 3, collections: { svc: { defaultVersion: null, versions: [{ ...entry, path, query }] } } };
    await assert.rejects(ingestRemoteReference(new CoordinateIndex(), { collection: "svc" }, manifest, async () => text), /invalid version entry/, `${path} ${query}`);
  }
});

test("an index that could reach outside its folder, or lies about a document, adds nothing", async () => {
  const text = JSON.stringify({ version: 3, pages: [["a", "a", {}]] });
  const version = { version: null, file: "coordinates/svc.json", hash: hashOf(text), path: "/api", query: "" };
  const index = new CoordinateIndex();
  index.add("existing", { route: { path: "", query: "" }, source: { version: 3, pages: [["page", "page", {}]] }, historical: false, hash: "x" });
  for (const [change, fault] of [
    [{ file: "../secrets.json" }, /invalid version entry/],
    [{ file: "coordinates/../../secrets.json" }, /invalid version entry/],
    [{ file: "coordinates/.hidden.json" }, /invalid version entry/],
    [{ file: "https://evil.example/x.json" }, /invalid version entry/],
    [{ file: "/etc/passwd.json" }, /invalid version entry/],
    [{ path: "//evil.example" }, /invalid version entry/],
    [{ path: "/api#x" }, /invalid version entry/],
    [{ hash: hashOf("something else") }, /doesn't match the hash/],
    [{ hash: "md5-abc" }, /invalid version entry/],
  ] as const) {
    const manifest = { version: 3, collections: { svc: { defaultVersion: null, versions: [{ ...version, ...change }] } } };
    await assert.rejects(ingestRemoteReference(index, { collection: "svc" }, manifest, async () => text), fault, JSON.stringify(change));
  }
  await assert.rejects(
    ingestRemoteReference(index, { collection: "svc" }, { version: 3, collections: { svc: { defaultVersion: "v2", versions: [] } } }, async () => text),
    /the default version has no entry/,
  );
  assert.deepEqual([...index], [["existing:page", "/page"]]);
  assert.equal((await ingestRemoteReference(index, { collection: "missing" }, { version: 3, collections: {} }, async () => text)).length, 1);
  assert.equal(index.hasCollection("missing"), false);
});

test("an older format is refused with what to do, locally and remotely, and nothing already cited is lost", async () => {
  const root = mkdtempSync(join(tmpdir(), "nimbus-coordinates-old-format-"));
  const realFetch = globalThis.fetch;
  try {
    for (const raw of [
      { version: 1, collections: { svc: { defaultVersion: null, entries: { old: { url: "/old" } } } } },
      { version: 2, collections: { svc: { defaultVersion: null, pages: [{ url: "/api", entries: { good: 0 } }] } } },
    ]) {
      writeFileSync(join(root, "coordinates.json"), JSON.stringify(raw));
      const index = (await buildCitationIndex([{ collection: "local", spec }], ".")).index;
      const before = [...index];
      const warnings: string[] = [];
      const logger = { warn: (message: string) => warnings.push(message) };
      const reads = new RegExp(`format ${raw.version}, which this Nimbus no longer reads; the site that publishes it needs a newer Nimbus`);
      await assert.rejects(ingestApiReferences([{ collection: "svc", manifest: "coordinates.json" }], index, root, logger), reads);
      globalThis.fetch = async () => new Response(JSON.stringify(raw));
      await ingestApiReferences([{ collection: "svc", manifest: "https://example.com/coordinates.json" }], index, root, logger);
      assert.match(warnings[0]!, reads);
      assert.match(warnings[0]!, /Citations to it will resolve to "#"/);
      assert.deepEqual([...index], before);
    }
  } finally {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a checked-in folder is read from disk: the index, and each cited version beside it", async () => {
  const root = mkdtempSync(join(tmpdir(), "nimbus-coordinates-folder-"));
  try {
    const result = await buildCitationIndex(versioned, ".");
    writeFolder(join(root, "vendor"), published(result));
    const index = new CoordinateIndex();
    await ingestApiReferences([{ collection: "svc", manifest: "vendor/coordinates.json", versions: ["v1"] }], index, root, none);
    assert.deepEqual([...index].sort(), [...result.index].sort());
    // A version file that is missing is this site's to fix, so it fails the build.
    rmSync(join(root, "vendor", "coordinates", "svc", "v1.json"));
    await assert.rejects(
      ingestApiReferences([{ collection: "svc", manifest: "vendor/coordinates.json", versions: ["v1"] }], new CoordinateIndex(), root, none),
      /apiReferences manifest for "svc" from vendor\/coordinates\.json/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("over HTTPS each version is fetched from beside the index, with the origin on every link", async () => {
  const result = await buildCitationIndex(versioned, ".");
  const files = published(result);
  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      fetched.push(url);
      const file = url.replace("https://example.com/docs/nimbus-api/", "");
      return file in files ? new Response(files[file]) : new Response("no", { status: 404 });
    };
    const local = await buildCitationIndex([{ collection: "local", spec }], ".");
    const index = local.index;
    const warnings: string[] = [];
    await ingestApiReferences(
      [{ collection: "svc", manifest: "https://example.com/docs/nimbus-api/coordinates.json", origin: "https://example.com/docs/", versions: ["v1"] }],
      index, ".", { warn: (message) => warnings.push(message) },
    );
    assert.deepEqual(warnings, []);
    assert.deepEqual(fetched, [
      "https://example.com/docs/nimbus-api/coordinates.json",
      "https://example.com/docs/nimbus-api/coordinates/svc/v2.json",
      "https://example.com/docs/nimbus-api/coordinates/svc/v1.json",
    ]);
    assert.equal(index.get("svc@v1:create"), "https://example.com/docs/svc/v1/charges/create");
    assert.equal(index.get("local:create"), "/local/charges/create");
    // A version file the publisher no longer has: warned, and the collection is left out whole.
    delete files["coordinates/svc/v1.json"];
    const partial = new CoordinateIndex();
    await ingestApiReferences(
      [{ collection: "svc", manifest: "https://example.com/docs/nimbus-api/coordinates.json", versions: ["v1"] }],
      partial, ".", { warn: (message) => warnings.push(message) },
    );
    assert.equal(partial.size, 0);
    assert.match(warnings[0]!, /HTTP 404/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a base goes in front of same-site links only, and the digest follows the content and the routes", async () => {
  const { index } = await buildCitationIndex(versioned, ".");
  const based = index.withBase("/docs/");
  assert.equal(based.get("svc:create"), "/docs/svc/charges/create");
  assert.notEqual(based.digest, index.digest);
  assert.equal((await buildCitationIndex(versioned, ".")).index.digest, index.digest);
  const moved = await buildCitationIndex([
    { collection: "svc", versions: [{ version: "v2", spec }, { version: "v1", default: true, spec }] },
  ], ".");
  assert.notEqual(moved.index.digest, index.digest);
  const remote = new CoordinateIndex();
  remote.add("far", { route: { path: "/api", query: "", origin: "https://far.example" }, source: { version: 3, pages: [["a", "a", {}]] }, historical: false, hash: "x" });
  assert.equal(remote.withBase("/docs").get("far:a"), "https://far.example/api/a");
});

test("the build's own module carries each document once and resolves the same", async () => {
  const { index } = await buildCitationIndex(versioned, ".");
  const payload = index.toPayload();
  // The default version is two scopes over one document.
  assert.equal(payload.scopes.length, 3);
  assert.equal(payload.documents.length, 2);
  const loaded = CoordinateIndex.fromPayload(JSON.parse(JSON.stringify(payload)));
  assert.deepEqual([...loaded].sort(), [...index].sort());
  assert.equal(loaded.digest, index.digest);
});
