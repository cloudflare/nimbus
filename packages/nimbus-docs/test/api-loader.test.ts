// Guards the `apiCollection()` loader: each entry carries its prepared page,
// the root carries shared navigation, and the root's empty slug maps to Astro's
// `index` id. It also covers content-addressed parsing and multi-spec isolation.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { apiCollection } from "../src/content.js";
import {
  activatePreparedApiNav,
  isPreparedApiPage,
} from "../src/_internal/api/prepared.js";
import {
  buildApiModel,
  clearApiModelCache,
  getApiNav,
  getApiPageProps,
  getApiPageSlugs,
  apiSchemaVersion,
  type ApiModel,
  type ApiPageProps,
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
  const log = (level: string) => (msg: string) =>
    void logs.push({ level, msg });
  return {
    logs,
    context: {
      collection,
      store: store as unknown as import("astro/loaders").LoaderContext["store"],
      meta: { get: () => undefined, set() {}, has: () => false, delete() {} },
      logger: {
        info: log("info"),
        warn: log("warn"),
        error: log("error"),
        debug: log("debug"),
        label: "t",
        fork: () => makeContext(collection, store).context.logger,
      } as never,
      config: { root: pathToFileURL(ROOT) } as never,
      parseData: async <T>({ data }: { data: T }) => data,
      renderMarkdown: async () => ({ html: "" }),
      generateDigest: (v: unknown) => JSON.stringify(v).length.toString(36),
      watcher: undefined,
    } as import("astro/loaders").LoaderContext,
  };
}

async function runLoader(
  collection: string,
  spec: string | Record<string, unknown>,
) {
  const store = makeStore();
  const { logs, context } = makeContext(collection, store);
  const { loader } = apiCollection({ collection, spec });
  await loader.load(context);
  return { store, logs };
}

function withoutPreparedCode(page: ApiPageProps): ApiPageProps {
  const copy = structuredClone(page);
  if (copy.kind !== "operation") return copy;
  for (const sample of copy.samples) delete sample.highlightedHtml;
  for (const response of copy.responses) {
    if (response.example) delete response.example.highlightedHtml;
  }
  for (const body of copy.additionalBodies ?? []) {
    if (body.example) delete body.example.highlightedHtml;
  }
  return copy;
}

let smallco: ApiModel;
before(async () => {
  smallco = await buildApiModel({
    collection: "api",
    spec: fixtureText("smallco.yaml"),
  });
});

describe("apiCollection loader — prepared index", () => {
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

  test("entries carry prepared page data and only roots carry shared navigation", async () => {
    const { store } = await runLoader("api", "test/fixtures/api/smallco.yaml");
    for (const entry of store.values()) {
      const keys = Object.keys(entry.data);
      assert.ok(keys.includes("coordinate"), "carries coordinate");
      assert.ok(keys.includes("title"), "carries title");
      assert.ok(keys.includes("prepared"), "carries prepared runtime data");
      for (const key of keys)
        assert.ok(
          ["coordinate", "title", "description", "prepared"].includes(key),
          `unexpected data key "${key}"`,
        );
      assert.equal(typeof entry.data.coordinate, "string");
      assert.equal(typeof entry.data.title, "string");
      const prepared = entry.data.prepared as {
        page: { coordinate: string };
        nav?: unknown;
      };
      assert.equal(prepared.page.coordinate, entry.data.coordinate);
      assert.equal("nav" in prepared, entry.id === "index");
      assert.equal(entry.body, undefined, "no MDX body");
      assert.equal(entry.rendered, undefined);
    }
  });

  test("prepared entries stay bounded", async () => {
    const { store } = await runLoader("api", "test/fixtures/api/smallco.yaml");
    const bytes = Buffer.byteLength(JSON.stringify(store.values()));
    const perEntry = bytes / store.keys().length;
    assert.ok(
      perEntry < 4096,
      `~${perEntry.toFixed(0)} B/entry should be < 4 KB`,
    );
  });

  test("prepared runtime validation requires UI-consumed code HTML", async () => {
    const { store } = await runLoader("api", "test/fixtures/api/smallco.yaml");
    const operation = [...store.values()].find(
      (entry) =>
        (entry.data.prepared as { page?: { kind?: string } }).page?.kind ===
        "operation",
    );
    assert.ok(operation);
    const prepared = structuredClone(operation.data.prepared);
    assert.equal(isPreparedApiPage(prepared), true);
    const page = (prepared as { page: ApiPageProps }).page;
    assert.equal(page.kind, "operation");
    if (page.kind !== "operation") return;
    delete page.samples[0]?.highlightedHtml;
    assert.equal(isPreparedApiPage(prepared), false);
    for (const malformed of [null, { highlightedHtml: "" }]) {
      const invalid = structuredClone(operation.data.prepared) as {
        page: { samples: unknown[] };
      };
      invalid.page.samples = [malformed];
      assert.equal(isPreparedApiPage(invalid), false);
    }
    const invalidBodies = structuredClone(operation.data.prepared) as {
      page: { additionalBodies: unknown };
    };
    invalidBodies.page.additionalBodies = {};
    assert.equal(isPreparedApiPage(invalidBodies), false);
  });

  test("versioned prepared navigation matches direct model projection", async () => {
    const spec = smallcoAsObject();
    const { store } = await runLoaderOpts({
      collection: "api",
      versions: [
        { version: "v2", spec, default: true },
        { version: "v1", spec },
      ],
    });

    for (const { version, rootId, prefix, mountPath } of [
      { version: "v2", rootId: "index", prefix: "", mountPath: "/api" },
      { version: "v1", rootId: "v1", prefix: "v1/", mountPath: "/api/v1" },
    ]) {
      const root = store.get(rootId);
      assert.ok(root);
      const preparedRoot = root.data.prepared as {
        nav: Parameters<typeof activatePreparedApiNav>[0];
      };
      const model = await buildApiModel({ collection: "api", spec, mountPath });

      for (const entry of store.values()) {
        const belongsToVersion = prefix
          ? entry.id === rootId || entry.id.startsWith(prefix)
          : entry.id !== "v1" && !entry.id.startsWith("v1/");
        if (!belongsToVersion) continue;
        const prepared = entry.data.prepared as {
          page: ApiPageProps;
        };
        assert.equal(entry.data.version, version);
        assert.deepEqual(
          withoutPreparedCode(prepared.page),
          getApiPageProps(model, prepared.page.coordinate),
        );
        assert.deepEqual(
          activatePreparedApiNav(preparedRoot.nav, prepared.page.coordinate),
          getApiNav(model, prepared.page.coordinate),
        );
      }
    }
  });

  test("inline-object spec works without touching the filesystem", async () => {
    const spec = JSON.parse(JSON.stringify(smallcoAsObject()));
    const { store } = await runLoader("api-inline", spec);
    assert.ok(store.keys().length > 0);
    assert.ok(store.has("index"));
  });

  test("an untagged operationId `index` collides with the root id and is rejected", async () => {
    // Without the guard this silently clobbers the api-root entry (both mint
    // store id `index`), dropping a page from the agent index while its HTML
    // route still renders. The loader must fail the build with a pointed error.
    const spec: Record<string, unknown> = {
      openapi: "3.0.0",
      info: { title: "Collide", version: "1.0.0" },
      paths: {
        "/index": {
          get: {
            operationId: "index",
            summary: "Index",
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    await assert.rejects(
      () => runLoader("api-collide", spec),
      /same route id "index"/,
    );
  });
});

describe("canonical routing — one URL per page, no duplicate or /index alias", () => {
  test("every page resolves to a unique URL and the root is the bare collection path", () => {
    const slugs = getApiPageSlugs(smallco);
    const root = slugs.find((s) => s.slug === "");
    assert.ok(root, "model exposes an api-root page (empty slug)");
    const base = getApiPageProps(smallco, root!.coordinate).href;
    assert.ok(
      !/\/index$/.test(base),
      `root URL "${base}" must be the bare collection path, not an /index alias`,
    );

    const hrefs = slugs.map((s) => getApiPageProps(smallco, s.coordinate).href);
    assert.equal(
      new Set(hrefs).size,
      hrefs.length,
      "two coordinates share a URL — the SEO duplicate a canonical would have to paper over",
    );
    assert.equal(
      hrefs.filter((h) => h === base).length,
      1,
      "exactly one page owns the canonical root URL",
    );
    assert.ok(
      !hrefs.includes(`${base}/index`),
      "no page is served at the /index duplicate of the root",
    );
  });

  test("the root's markdown twin lives at <root>/index.md without minting an HTML /index route", () => {
    const root = getApiPageSlugs(smallco).find((s) => s.slug === "")!;
    const props = getApiPageProps(smallco, root.coordinate);
    assert.equal(props.markdownHref, `${props.href}/index.md`);
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
    const findActive = (
      items: ReturnType<typeof getApiNav>["items"],
    ): string | undefined => {
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
    const h2 = await buildApiModel({
      collection: "edit",
      spec: original + "\n# edited\n",
    });
    assert.notEqual(h1, h2, "different bytes → different key → reparsed");
  });

  test("a broken spec fails with a legible error, both attempts (reject not cached)", async () => {
    const broken = { collection: "broken", spec: fixtureText("broken.yaml") };
    await assert.rejects(
      () => buildApiModel(broken),
      (err: Error) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.length > 0);
        return true;
      },
    );
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
    const aHrefs = getApiPageSlugs(a).map(
      (s) => getApiPageProps(a, s.coordinate).href,
    );
    const bHrefs = getApiPageSlugs(b).map(
      (s) => getApiPageProps(b, s.coordinate).href,
    );
    assert.ok(aHrefs.length > 0);
    assert.ok(
      aHrefs.every((h) => h === "/alpha" || h.startsWith("/alpha/")),
      "all under /alpha",
    );
    assert.ok(
      bHrefs.every((h) => h === "/beta" || h.startsWith("/beta/")),
      "all under /beta",
    );
    assert.equal(
      aHrefs.filter((h) => bHrefs.includes(h)).length,
      0,
      "URL spaces are disjoint",
    );
  });

  test("independent DataStores: two loaders don't bleed ids", async () => {
    const one = await runLoader("alpha", "test/fixtures/api/smallco.yaml");
    const two = await runLoader("beta", "test/fixtures/api/smallco.yaml");
    // Same relative slugs (same spec) but each store is self-contained.
    assert.deepEqual(one.store.keys().sort(), two.store.keys().sort());
    assert.notEqual(one.store, two.store);
  });
});

async function runLoaderOpts(options: Parameters<typeof apiCollection>[0]) {
  const store = makeStore();
  const { logs, context } = makeContext(options.collection, store);
  const { loader } = apiCollection(options);
  await loader.load(context);
  return { store, logs };
}

async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const real = console.warn;
  console.warn = (...args: unknown[]) =>
    void warnings.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.warn = real;
  }
  return warnings;
}

function missingOpIdSpec(): Record<string, unknown> {
  return {
    openapi: "3.0.0",
    info: { title: "No opId", version: "1.0.0" },
    paths: {
      "/widgets": { get: { responses: { "200": { description: "ok" } } } },
    },
  };
}

describe("apiCollection — missing operationId is lenient by default, strict on opt-in", () => {
  test("default: an operationId-less op indexes via a path-derived fallback page + aggregate warning", async () => {
    let store!: Awaited<ReturnType<typeof runLoaderOpts>>["store"];
    const warnings = await captureWarnings(async () => {
      ({ store } = await runLoaderOpts({
        collection: "leni",
        spec: missingOpIdSpec(),
      }));
    });
    assert.ok(
      store.has("get/widgets"),
      "the fallback page is indexed (build did not abort)",
    );
    assert.ok(
      warnings.some((w) =>
        /lack a usable operationId and fell back to/i.test(w),
      ),
      "the guaranteed aggregate line is surfaced",
    );
  });

  test("the aggregate survives the per-op warning cap (25 missing ids > 20-line cap)", async () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) {
      paths[`/w${i}`] = {
        get: { responses: { "200": { description: "ok" } } },
      };
    }
    const spec = {
      openapi: "3.0.0",
      info: { title: "Many", version: "1.0.0" },
      paths,
    };
    const warnings = await captureWarnings(async () => {
      await runLoaderOpts({ collection: "captest", spec });
    });
    assert.ok(
      warnings.some((w) => /…and \d+ more warning/.test(w)),
      "per-op warnings are truncated by the cap",
    );
    assert.ok(
      warnings.some((w) =>
        /25 operation\(s\) lack a usable operationId/.test(w),
      ),
      "the aggregate survives truncation and reports the full count",
    );
  });

  test("requireOperationId: true reaches the LOADER path and fails the build (regression: flag was dropped)", async () => {
    await assert.rejects(
      () =>
        runLoaderOpts({
          collection: "stricti",
          spec: missingOpIdSpec(),
          requireOperationId: true,
        }),
      /operationId/i,
      "strict must abort via apiCollection(), not silently warn",
    );
  });

  test("buildApiModel keys strict and lenient separately (same bytes, no cache alias)", async () => {
    const spec = missingOpIdSpec();
    const lenient = await buildApiModel({ collection: "cachesep", spec });
    assert.ok(lenient, "lenient builds");
    await assert.rejects(
      () =>
        buildApiModel({
          collection: "cachesep",
          spec,
          requireOperationId: true,
        }),
      /operationId/i,
      "strict is a distinct cache key, so it re-parses and fails",
    );
  });

  test("a collision involving a synthesized fallback names the real fix (add an operationId)", async () => {
    const idParam = {
      name: "id",
      in: "path",
      required: true,
      schema: { type: "string" },
    };
    const spec = {
      openapi: "3.0.0",
      info: { title: "Collide", version: "1.0.0" },
      paths: {
        "/a/{id}": {
          get: {
            parameters: [idParam],
            responses: { "200": { description: "ok" } },
          },
        },
        "/a/id": { get: { responses: { "200": { description: "ok" } } } },
      },
    };
    await assert.rejects(
      () => buildApiModel({ collection: "synthcollide", spec }),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.match(
          msg,
          /duplicate operation coordinate "get\/a\/id"/i,
          "the failure is the coordinate collision",
        );
        assert.match(
          msg,
          /add an operationId/i,
          "points at adding an operationId, not just 'rename'",
        );
        assert.doesNotMatch(
          msg,
          /path parameter/i,
          "no unrelated spec-deviation noise",
        );
        return true;
      },
    );
  });

  test("edge paths: root `/` and repeated slashes render; a nameless `{}` param is fatal", async () => {
    const base = (paths: Record<string, unknown>) => ({
      openapi: "3.0.0",
      info: { title: "Edge", version: "1.0.0" },
      paths,
    });
    const root = await buildApiModel({
      collection: "edgeroot",
      spec: base({
        "/": { get: { responses: { "200": { description: "ok" } } } },
      }),
    });
    assert.ok(
      getApiPageSlugs(root).some((s) => s.coordinate === "get"),
      "root op folds to `get`",
    );
    const dbl = await buildApiModel({
      collection: "edgeslash",
      spec: base({
        "/a//b": { get: { responses: { "200": { description: "ok" } } } },
      }),
    });
    assert.ok(
      getApiPageSlugs(dbl).some((s) => s.coordinate === "get/a/b"),
      "`/a//b` folds to `get/a/b`",
    );
    await assert.rejects(
      () =>
        buildApiModel({
          collection: "edgebrace",
          spec: base({
            "/x/{}": { get: { responses: { "200": { description: "ok" } } } },
          }),
        }),
      /route|path segment|escape|empty/i,
      "a `{}` param is malformed and fails, never a broken slug",
    );
  });
});

describe("apiCollection — a non-default version id shadowing a default-version page", () => {
  const OK = { responses: { "200": { description: "ok" } } };
  const versionSpec = (paths: Record<string, unknown>) => ({
    openapi: "3.0.0",
    info: { title: "V", version: "1.0.0" },
    paths,
  });

  test("when the shadowed default page is derived, the fix is an override (renaming can't move it)", async () => {
    // Default version derives `/charges` → `charges/list` (top segment
    // `charges`); the non-default version id `charges` then claims the same
    // `/shadow/charges` — and the shadowed slug is derived.
    await assert.rejects(
      () =>
        runLoaderOpts({
          collection: "shadow",
          versions: [
            {
              version: "stable",
              default: true,
              spec: versionSpec({
                "/charges": { get: { operationId: "listCharges", ...OK } },
              }),
              routes: { convention: "resource-action-v1" },
            },
            {
              version: "charges",
              spec: versionSpec({
                "/widgets": { get: { operationId: "listWidgets", ...OK } },
              }),
              routes: { convention: "resource-action-v1" },
            },
          ],
        }),
      (err: Error) => {
        assert.match(
          err.message,
          /version "charges" of collection "shadow" collides/,
        );
        assert.match(err.message, /routes\.operations` override/);
        assert.doesNotMatch(err.message, /the colliding operation\/tag/);
        return true;
      },
    );
  });

  test("when the shadowed default page is override-routed, adjusting the override target is the fix", async () => {
    await assert.rejects(
      () =>
        runLoaderOpts({
          collection: "shadow3",
          versions: [
            {
              version: "stable",
              default: true,
              spec: versionSpec({
                "/charges": { get: { operationId: "listCharges", ...OK } },
              }),
              routes: {
                convention: "resource-action-v1",
                operations: { listCharges: "charges/summary" },
              },
            },
            {
              version: "charges",
              spec: versionSpec({
                "/widgets": { get: { operationId: "listWidgets", ...OK } },
              }),
              routes: { convention: "resource-action-v1" },
            },
          ],
        }),
      (err: Error) => {
        assert.match(
          err.message,
          /version "charges" of collection "shadow3" collides/,
        );
        assert.match(
          err.message,
          /adjust the `routes\.operations` override target/i,
        );
        assert.doesNotMatch(err.message, /the colliding operation\/tag/);
        return true;
      },
    );
  });

  test("when the shadowed default page is identity-routed, renaming the operation/tag is the fix", async () => {
    // No routes policy → the default page's slug IS its identity (tag
    // `charges` → `charges/list`), so renaming actually moves it.
    await assert.rejects(
      () =>
        runLoaderOpts({
          collection: "shadow2",
          versions: [
            {
              version: "stable",
              default: true,
              spec: versionSpec({
                "/a": {
                  get: { operationId: "list", tags: ["charges"], ...OK },
                },
              }),
            },
            {
              version: "charges",
              spec: versionSpec({
                "/widgets": { get: { operationId: "listWidgets", ...OK } },
              }),
            },
          ],
        }),
      (err: Error) => {
        assert.match(
          err.message,
          /version "charges" of collection "shadow2" collides/,
        );
        assert.match(err.message, /the colliding operation\/tag/);
        assert.doesNotMatch(err.message, /routes\.operations` override/);
        return true;
      },
    );
  });
});

// A tiny inline OpenAPI doc mirroring smallco's shape, for the no-fs path.
function smallcoAsObject(): Record<string, unknown> {
  return {
    openapi: "3.0.0",
    info: { title: "Inline", version: "1.0.0" },
    paths: {
      "/things": {
        get: {
          operationId: "listThings",
          summary: "List things",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}
