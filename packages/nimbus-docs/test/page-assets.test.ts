import assert from "node:assert/strict";
import test from "node:test";
import {
  createPageAssetReader,
  parsePageAssetIndex,
} from "../src/_internal/page-assets.ts";
import {
  createStagedAssetReader,
  validateStagedAssetPath,
} from "../src/_internal/staged-asset-reader.ts";

const fixture = (id = "one") => ({
  revision: 1,
  rows: [{ id, slug: id, title: id, location: { filename: "record-ab.json" } }],
  metadata: { opaque: true },
});

test("staged reader uses platform hooks before files, applies base, and supports context-free binding reads", async () => {
  let called = "";
  const read = createStagedAssetReader({
    base: "/docs",
    fetchStagedAsset(path, request) {
      called = path;
      assert.equal(request.method, "GET");
      return new Response("platform");
    },
    async readStagedAssetFile() {
      throw new Error("must not use filesystem");
    },
  });
  assert.equal(await read("_nimbus/pages/record-ab.json"), "platform");
  assert.equal(called, "/docs/_nimbus/pages/record-ab.json");
});

test("staged reader uses filesystem before HTTP, and missing binding assets fail without fallback", async () => {
  const read = createStagedAssetReader({
    base: "/",
    fetchStagedAsset: () => null,
    async readStagedAssetFile(path) {
      return path;
    },
  });
  assert.equal(
    await read("_nimbus/pages/record-ab.json"),
    "_nimbus/pages/record-ab.json",
  );
  const missing = createStagedAssetReader({
    base: "/",
    fetchStagedAsset: () => new Response("missing", { status: 404 }),
    async readStagedAssetFile() {
      throw new Error("wrong fallback");
    },
  });
  await assert.rejects(missing("_nimbus/pages/record-ab.json"), /returned 404/);
});

test("staged reader same-origin fallback uses GET and refuses redirects", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(
      String(input),
      "https://docs.example/base/_nimbus/pages/record-ab.json",
    );
    assert.equal(init?.redirect, "manual");
    return new Response("http");
  }) as typeof fetch;
  try {
    const read = createStagedAssetReader({
      base: "/base",
      fetchStagedAsset: () => null,
      async readStagedAssetFile() {
        return null;
      },
    });
    assert.equal(
      await read("_nimbus/pages/record-ab.json", {
        request: new Request("https://docs.example/base/api"),
      }),
      "http",
    );
    await assert.rejects(
      read("_nimbus/pages/record-ab.json"),
      /build output file .* is missing/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("staged and page paths reject traversal, URLs and encoded delimiters", async () => {
  for (const path of [
    "../secret",
    "a/../secret",
    "/etc/passwd",
    "a\\b",
    "a/%2e%2e/b",
    "https://evil/file",
    "a?query",
    "a#fragment",
    "a//b",
  ]) {
    assert.throws(() => validateStagedAssetPath(path), /invalid staged asset/);
  }
  const reader = createPageAssetReader({ readAsset: async () => "{}" });
  await assert.rejects(reader.readIndex("wrong.json"), /invalid page asset/);
});

test("index validates identities, row fields and revision without interpreting consumer metadata", () => {
  const parsed = parsePageAssetIndex(fixture());
  assert.equal(parsed.byId.get("one"), parsed.bySlug.get("one"));
  assert.deepEqual(parsed.metadata, { opaque: true });
  assert.throws(
    () => parsePageAssetIndex({ ...fixture(), revision: 2 }),
    /revision/,
  );
  assert.throws(
    () =>
      parsePageAssetIndex({
        ...fixture(),
        rows: [...fixture().rows, ...fixture().rows],
      }),
    /duplicate/,
  );
});

test("reader coalesces concurrent loads, evicts by bytes and never caches failures", async () => {
  let calls = 0;
  const serialized = JSON.stringify(fixture());
  const reader = createPageAssetReader({
    // Room for exactly one index in the index pool (three quarters).
    cacheBudgetBytes: Math.ceil(((serialized.length * 2 + 64) * 4) / 3),
    readAsset: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return serialized;
    },
  });
  const [a, b] = await Promise.all([
    reader.readIndex("index-aa.json"),
    reader.readIndex("index-aa.json"),
  ]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  await reader.readIndex("index-bb.json");
  assert.equal(reader.stats.pools.index.entries, 1);
  assert.ok(reader.stats.pools.index.bytes <= reader.stats.pools.index.budget);
  await reader.readIndex("index-aa.json");
  assert.equal(calls, 3);
  reader.clear();
  assert.equal(reader.stats.bytes, 0);
  let attempts = 0;
  const broken = createPageAssetReader({
    readAsset: async () => (++attempts === 1 ? "invalid" : serialized),
  });
  await assert.rejects(broken.readIndex("index-aa.json"), /not valid JSON/);
  await broken.readIndex("index-aa.json");
  assert.equal(attempts, 2);
});

test("packs select own record keys and oversized assets do not enter cache", async () => {
  const reader = createPageAssetReader({
    readAsset: async () =>
      JSON.stringify({ revision: 1, records: { one: { body: "opaque" } } }),
  });
  assert.deepEqual(
    await reader.readRecord({ filename: "pack-aa.json", key: "one" }),
    { body: "opaque" },
  );
  await assert.rejects(
    reader.readRecord({ filename: "pack-aa.json", key: "constructor" }),
    /absent/,
  );
  const limited = createPageAssetReader({
    maxAssetBytes: 1,
    readAsset: async () => "{}",
  });
  await assert.rejects(
    limited.readRecord({ filename: "record-aa.json" }),
    /exceeds/,
  );
  assert.equal(limited.stats.entries, 0);
});

test("pending read admission is bounded while duplicate requests still coalesce", async () => {
  let release!: (value: string) => void;
  const reader = createPageAssetReader({
    maxPendingReads: 1,
    readAsset: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const first = reader.readIndex("index-aa.json");
  const duplicate = reader.readIndex("index-aa.json");
  await assert.rejects(reader.readIndex("index-bb.json"), /reader is busy/);
  await Promise.resolve();
  release(JSON.stringify(fixture()));
  assert.equal(await first, await duplicate);
  assert.equal(reader.stats.pending, 0);
});

test("read queue bounds transient loads and clear prevents pending results repopulating the cache", async () => {
  const releases: Array<(value: string) => void> = [];
  const reader = createPageAssetReader({
    maxConcurrentReads: 1,
    readAsset: () => new Promise((resolve) => releases.push(resolve)),
  });
  const first = reader.readIndex("index-aa.json");
  const second = reader.readIndex("index-bb.json");
  await Promise.resolve();
  assert.equal(reader.stats.active, 1);
  assert.equal(reader.stats.queued, 1);
  assert.equal(releases.length, 1);
  reader.clear();
  releases.shift()!(JSON.stringify(fixture()));
  await first;
  await Promise.resolve();
  assert.equal(releases.length, 1);
  releases.shift()!(JSON.stringify(fixture()));
  await second;
  assert.equal(reader.stats.entries, 0);
  assert.equal(reader.stats.active, 0);
});

test("asset byte limit counts multibyte and astral Unicode without allocating an encoding buffer", async () => {
  for (const value of [
    "é",
    "中",
    "😀",
    "a\ud800",
    "a".repeat(65_534) + "😀" + "é中".repeat(35_000),
    "中".repeat(21_845) + "😀",
  ]) {
    const body = JSON.stringify(value);
    const bytes = new TextEncoder().encode(body).byteLength;
    const pass = createPageAssetReader({
      maxAssetBytes: bytes,
      readAsset: async () => body,
    });
    assert.equal(await pass.readRecord({ filename: "record-aa.json" }), value);
    const fail = createPageAssetReader({
      maxAssetBytes: bytes - 1,
      readAsset: async () => body,
    });
    await assert.rejects(
      fail.readRecord({ filename: "record-aa.json" }),
      /exceeds/,
    );
  }
});

test("a cold index checks only lookup fields; a bad location fails when its row is read", async () => {
  const index = {
    revision: 1,
    rows: [
      {
        id: "good",
        slug: "good",
        title: "Good",
        location: { filename: "record-aa.json" },
      },
      {
        id: "bad",
        slug: "bad",
        title: "Bad",
        location: { filename: "../escape.json" },
      },
    ],
  };
  const reader = createPageAssetReader({
    readAsset: async (path) =>
      path.endsWith("index-aa.json") ? JSON.stringify(index) : '{"ok":true}',
  });
  const parsed = await reader.readIndex("index-aa.json");
  assert.deepEqual(await reader.readRecord(parsed.byId.get("good")!.location), {
    ok: true,
  });
  await assert.rejects(
    reader.readRecord(parsed.byId.get("bad")!.location),
    /invalid/,
  );
  await assert.rejects(
    reader.readRecord({ filename: "record-aa.json", key: 7 } as never),
    /malformed page asset location/,
  );
});

test("loading many record packs never evicts a cached index", async () => {
  const index = JSON.stringify(fixture());
  const pack = JSON.stringify({
    revision: 1,
    records: { one: { body: "x".repeat(2000) } },
  });
  const reads: string[] = [];
  const reader = createPageAssetReader({
    cacheBudgetBytes: 64 * 1024,
    readAsset: async (path) => {
      reads.push(path);
      return path.includes("/index-") ? index : pack;
    },
  });
  await reader.readIndex("index-aa.json");
  for (let i = 0; i < 50; i++) {
    await reader.readRecord({
      filename: `pack-${i.toString(16).padStart(2, "0")}.json`,
      key: "one",
    });
  }
  await reader.readIndex("index-aa.json");
  assert.equal(reads.filter((path) => path.includes("/index-")).length, 1);
});
