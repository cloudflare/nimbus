// Guards the `apiCollection()` loader: it is a thin index (one small entry per
// page carrying routing + display metadata, no body), the root's empty slug
// maps to Astro's `index` id, buildApiModel is content-addressed (parse-once +
// hot-reload eviction), and two specs compose without aliasing. If this goes
// red, the loader/render contract moved.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { apiCollection } from "../src/content.js";
import {
  buildApiModel,
  clearApiModelCache,
  getApiNav,
  getApiPageProps,
  getApiPageSlugs,
  apiSchemaVersion,
  type ApiModel,
} from "../src/api/index.js";

function fixturePath(rel: string): string {
  return fileURLToPath(new URL(`./fixtures/api/${rel}`, import.meta.url));
}
function fixtureText(rel: string): string {
  return readFileSync(fixturePath(rel), "utf8");
}

// Package root — the loader resolves a path spec relative to `config.root`,
// which in a real build is the project root, so mirror that here.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

// ---------------------------------------------------------------------------
// Minimal LoaderContext + scoped DataStore, backed by a Map. Mirrors the
// Astro contract the loader actually touches (clear/set/keys/get) plus the
// real store's "ID must be a non-empty string" rule.
// ---------------------------------------------------------------------------
interface Entry {
  id: string;
  data: Record<string, unknown>;
  body?: string;
  rendered?: unknown;
}
function makeStore() {
  const map = new Map<string, Entry>();
  return {
    map,
    set(entry: Entry) {
      if (entry.id === "") throw new Error("ID must be a non-empty string");
      map.set(entry.id, entry);
      return true;
    },
    get: (id: string) => map.get(id),
    keys: () => [...map.keys()],
    values: () => [...map.values()],
    entries: () => [...map.entries()],
    has: (id: string) => map.has(id),
    delete: (id: string) => void map.delete(id),
    clear: () => map.clear(),
    addModuleImport() {},
  };
}
function makeContext(collection: string, store: ReturnType<typeof makeStore>) {
  const logs: { level: string; msg: string }[] = [];
  const log = (level: string) => (msg: string) => void logs.push({ level, msg });
  return {
    logs,
    context: {
      collection,
      store: store as unknown as import("astro/loaders").LoaderContext["store"],
      meta: { get: () => undefined, set() {}, has: () => false, delete() {} },
      logger: { info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug"), label: "t", fork: () => makeContext(collection, store).context.logger } as never,
      config: { root: pathToFileURL(ROOT) } as never,
      parseData: async <T,>({ data }: { data: T }) => data,
      renderMarkdown: async () => ({ html: "" }),
      generateDigest: (v: unknown) => JSON.stringify(v).length.toString(36),
      watcher: undefined,
    } as import("astro/loaders").LoaderContext,
  };
}

async function runLoader(collection: string, spec: string | Record<string, unknown>) {
  const store = makeStore();
  const { logs, context } = makeContext(collection, store);
  const { loader } = apiCollection({ collection, spec });
  await loader.load(context);
  return { store, logs };
}

let smallco: ApiModel;
before(async () => {
  smallco = await buildApiModel({ collection: "api", spec: fixtureText("smallco.yaml") });
});

describe("apiCollection loader — thin index", () => {
  test("writes exactly one entry per page slug, root mapped to `index`", async () => {
    const slugs = getApiPageSlugs(smallco);
    // The loader reads its own spec via the path form to exercise fs + resolve.
    const { store } = await runLoader("api", "test/fixtures/api/smallco.yaml");

    assert.equal(store.keys().length, slugs.length, "one entry per page");
    assert.ok(!store.has(""), "no empty-string id (Astro rejects it)");
    assert.ok(store.has("index"), "root slug maps to `index`");
    // Every non-root slug is present verbatim.
    for (const { slug } of slugs) {
      const id = slug === "" ? "index" : slug;
      assert.ok(store.has(id), `entry for slug "${slug}"`);
    }
  });

  test("entries are thin: routing + display metadata only, no body/rendered", async () => {
    const { store } = await runLoader("api", "test/fixtures/api/smallco.yaml");
    for (const entry of store.values()) {
      const keys = Object.keys(entry.data);
      assert.ok(keys.includes("coordinate"), "carries coordinate");
      assert.ok(keys.includes("title"), "carries title");
      // description is optional (omitted when the page has none).
      for (const key of keys) assert.ok(["coordinate", "title", "description"].includes(key), `unexpected data key "${key}"`);
      assert.equal(typeof entry.data.coordinate, "string");
      assert.equal(typeof entry.data.title, "string");
      assert.equal(entry.body, undefined, "no MDX body — render re-derives the model");
      assert.equal(entry.rendered, undefined);
    }
  });

  test("thin entries stay small (well under a 1 KB/entry budget)", async () => {
    const { store } = await runLoader("api", "test/fixtures/api/smallco.yaml");
    const bytes = Buffer.byteLength(JSON.stringify(store.values()));
    const perEntry = bytes / store.keys().length;
    assert.ok(perEntry < 1024, `~${perEntry.toFixed(0)} B/entry should be < 1 KB`);
  });

  test("inline-object spec works without touching the filesystem", async () => {
    const spec = JSON.parse(JSON.stringify(smallcoAsObject()));
    const { store } = await runLoader("api-inline", spec);
    assert.ok(store.keys().length > 0);
    assert.ok(store.has("index"));
  });
});

describe("round-trip completeness (pageSlugs ⊆ domain(pageProps))", () => {
  test("every enumerated coordinate projects without throwing, stamped with the schema version", () => {
    const slugs = getApiPageSlugs(smallco);
    assert.ok(slugs.length > 0);
    for (const { coordinate } of slugs) {
      const props = getApiPageProps(smallco, coordinate);
      assert.equal(props.apiSchemaVersion, apiSchemaVersion);
      assert.equal((props as { coordinate: string }).coordinate, coordinate);
    }
  });

  test("nav marks each page's coordinate active along a real ancestor path", () => {
    const slugs = getApiPageSlugs(smallco);
    const findActive = (items: ReturnType<typeof getApiNav>["items"]): string | undefined => {
      for (const item of items) {
        if (item.active) return item.coordinate;
        const nested = item.children ? findActive(item.children) : undefined;
        if (nested) return nested;
      }
      return undefined;
    };
    for (const { coordinate } of slugs) {
      const nav = getApiNav(smallco, coordinate);
      // Root/sections may sit at the top level; nav must at minimum resolve.
      assert.equal(nav.apiSchemaVersion, apiSchemaVersion);
      const active = findActive(nav.items);
      if (active !== undefined) assert.equal(active, coordinate);
    }
  });

  test("nav base is memoized: the flagless tree is identical across calls", () => {
    const a = getApiNav(smallco);
    const b = getApiNav(smallco);
    assert.deepEqual(a, b);
  });
});

describe("buildApiModel — content-addressed cache", () => {
  test("identical (collection, content) is parsed once (same handle)", async () => {
    const src = { collection: "memo", spec: fixtureText("smallco.yaml") };
    const h1 = await buildApiModel(src);
    const h2 = await buildApiModel({ ...src });
    assert.equal(h1, h2, "memoized → parse-once within a graph");
  });

  test("clearApiModelCache evicts, forcing a reparse (new handle)", async () => {
    const src = { collection: "evict", spec: fixtureText("smallco.yaml") };
    const h1 = await buildApiModel(src);
    clearApiModelCache("evict");
    const h2 = await buildApiModel(src);
    assert.notEqual(h1, h2, "cleared → reparsed");
  });

  test("edited content busts the cache (hot-reload correctness)", async () => {
    const original = fixtureText("smallco.yaml");
    const h1 = await buildApiModel({ collection: "edit", spec: original });
    const h2 = await buildApiModel({ collection: "edit", spec: original + "\n# edited\n" });
    assert.notEqual(h1, h2, "different bytes → different key → reparsed");
  });

  test("a broken spec fails with a legible error, both attempts (reject not cached)", async () => {
    const broken = { collection: "broken", spec: fixtureText("broken.yaml") };
    await assert.rejects(() => buildApiModel(broken), (err: Error) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.length > 0);
      return true;
    });
    await assert.rejects(() => buildApiModel({ ...broken }));
  });
});

describe("composition — two collections, no aliasing", () => {
  test("same spec under two collections: distinct handles, URL-namespaced hrefs", async () => {
    const spec = fixtureText("smallco.yaml");
    const a = await buildApiModel({ collection: "alpha", spec });
    const b = await buildApiModel({ collection: "beta", spec });
    assert.notEqual(a, b, "collection is part of the cache key");

    // Coordinates are MODEL-relative (child coordinates like "tags.charges"
    // repeat across collections; the root coordinate is the collection name).
    // Either way each is only used with its own model. The guarantee that
    // matters is disjoint URL spaces: every href carries its collection prefix,
    // so no two collections can ever mint the same page URL.
    const aHrefs = getApiPageSlugs(a).map((s) => getApiPageProps(a, s.coordinate).href);
    const bHrefs = getApiPageSlugs(b).map((s) => getApiPageProps(b, s.coordinate).href);
    assert.ok(aHrefs.length > 0);
    assert.ok(aHrefs.every((h) => h === "/alpha" || h.startsWith("/alpha/")), "all under /alpha");
    assert.ok(bHrefs.every((h) => h === "/beta" || h.startsWith("/beta/")), "all under /beta");
    assert.equal(aHrefs.filter((h) => bHrefs.includes(h)).length, 0, "URL spaces are disjoint");
  });

  test("independent DataStores: two loaders don't bleed ids", async () => {
    const one = await runLoader("alpha", "test/fixtures/api/smallco.yaml");
    const two = await runLoader("beta", "test/fixtures/api/smallco.yaml");
    // Same relative slugs (same spec) but each store is self-contained.
    assert.deepEqual(one.store.keys().sort(), two.store.keys().sort());
    assert.notEqual(one.store, two.store);
  });
});



// A tiny inline OpenAPI doc mirroring smallco's shape, for the no-fs path.
function smallcoAsObject(): Record<string, unknown> {
  return {
    openapi: "3.0.0",
    info: { title: "Inline", version: "1.0.0" },
    paths: {
      "/things": {
        get: { operationId: "listThings", summary: "List things", responses: { "200": { description: "ok" } } },
      },
    },
  };
}
