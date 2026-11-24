import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { virtualApiBuildConfigPlugin } from "../src/_internal/virtual-api-build-config.js";
import { declaresNoCollection } from "../src/_internal/parse-content-collections.js";
import { virtualConfigPlugin } from "../src/_internal/virtual-config.js";
import { virtualLastUpdatedPlugin } from "../src/_internal/last-updated-virtual.js";
import type { NimbusConfig } from "../src/types.js";
import { TEST_TMP } from "./fixtures/temp-root.js";

const sentinel = "raw-openapi-must-not-ship";
const api = [
  {
    collection: "api",
    spec: {
      openapi: "3.1.0",
      info: { title: "API", version: "1" },
      paths: {},
      sentinel,
    },
  },
];

test("runtime config strips inline API specs", async () => {
  const config = { api } as NimbusConfig;
  const plugin = virtualConfigPlugin(config, {
    getIndexedCollections: async () => ["api"],
    requestRenderingCollections: ["api"],
    base: "/docs",
    versionAlternates: {},
    apiCollections: ["api"],
    collectionRoutes: new Map(),
    unreadCollectionRoutes: [],
    headDefaults: {
      favicon: { file: "/favicon.ico", type: "image/x-icon" },
      socialImage: "/opengraph.png",
      ogCard: { sitePath: "/og.png", pagePrefix: "/og/", size: { width: 1200, height: 630 } },
      imageSizes: {},
    },
  });
  const source = await plugin.load("\0virtual:nimbus/config");

  assert.ok(source);
  assert.ok(!source.includes(sentinel));
  assert.match(source, /"spec":\{\}/);
  assert.match(source, /indexedCollections = \["api"\]/);
  // The whole-site search bundle is a served URL, base included.
  assert.match(source, /searchIndex = \{"bundle":"\/docs\/pagefind\/","merge":\[\]\}/);
});

test("runtime config leaves out build-only route settings", async () => {
  const routes = {
    convention: "resource-action-v2" as const,
    sections: "hierarchical" as const,
    operations: { listPets: "route-map-must-not-ship" },
    tagSegments: { pets: "animals" },
    stripPathPrefixes: ["/v1"],
  };
  const config = {
    api: [
      { collection: "one", spec: "./one.json", routes },
      { collection: "two", versions: [{ version: "v1", spec: "./two.json", routes }] },
    ],
  } as unknown as NimbusConfig;
  const plugin = virtualConfigPlugin(config, {
    getIndexedCollections: async () => ["one", "two"],
    requestRenderingCollections: ["one", "two"],
    base: "/",
    versionAlternates: {},
    apiCollections: ["one", "two"],
    collectionRoutes: new Map(),
    unreadCollectionRoutes: [],
    headDefaults: {
      favicon: { file: "/favicon.ico", type: "image/x-icon" },
      socialImage: "/opengraph.png",
      ogCard: { sitePath: "/og.png", pagePrefix: "/og/", size: { width: 1200, height: 630 } },
      imageSizes: {},
    },
  });
  const source = (await plugin.load("\0virtual:nimbus/config")) ?? "";
  assert.ok(!source.includes("route-map-must-not-ship"));
  assert.ok(!source.includes("animals"));
  assert.ok(!source.includes("stripPathPrefixes"));
  assert.equal(source.match(/"convention":"resource-action-v2","sections":"hierarchical"/g)?.length, 2);
});

test("build-only API config retains specs and the project root", () => {
  const plugin = virtualApiBuildConfigPlugin(api, "/project");
  const source = plugin.load("\0virtual:nimbus/api-build-config");

  assert.ok(source);
  assert.ok(source.includes(sentinel));
  assert.ok(source.includes("/project"));
});

test("request rendering resolves last-updated from prepared data", () => {
  const plugin = virtualLastUpdatedPlugin({
    "src/content/docs/index.mdx": "2026-01-01T00:00:00.000Z",
  });
  assert.equal(plugin.enforce, "pre");
  const id = plugin.resolveId(
    "./git-last-updated-D5zEYWjA.js",
    "/package/dist/runtime.js",
  );
  assert.equal(id, "\0virtual:nimbus/last-updated");
  assert.equal(
    plugin.resolveId(
      "/package/dist/git-last-updated-D5zEYWjA.js?commonjs-proxy",
      "/package/dist/runtime.js?astro",
    ),
    "\0virtual:nimbus/last-updated",
  );
  const source = plugin.load(id!);
  assert.match(source!, /2026-01-01T00:00:00\.000Z/);
  assert.doesNotMatch(source!, /node:child_process/);
});

test("a content.config.ts edit invalidates the virtual config in dev", async () => {
  const lists: string[][] = [["docs"], ["docs", "blog"]];
  const plugin = virtualConfigPlugin({} as NimbusConfig, {
    getIndexedCollections: async () => lists.shift() ?? ["docs", "blog"],
    requestRenderingCollections: [],
    base: "/",
    versionAlternates: {},
    apiCollections: [],
    collectionRoutes: new Map(),
    unreadCollectionRoutes: [],
    headDefaults: {
      favicon: { file: "/favicon.ico", type: "image/x-icon" },
      socialImage: "/opengraph.png",
      ogCard: { sitePath: "/og.png", pagePrefix: "/og/", size: { width: 1200, height: 630 } },
      imageSizes: {},
    },
    contentConfigPath: "/project/src/content.config.ts",
  });
  assert.match(
    (await plugin.load("\0virtual:nimbus/config")) ?? "",
    /indexedCollections = \["docs"\]/,
  );
  let invalidatedAll = 0;
  const server = {
    moduleGraph: {
      getModuleById: () => undefined,
      invalidateModule: () => {},
      invalidateAll: () => {
        invalidatedAll += 1;
      },
    },
  };
  plugin.handleHotUpdate?.({ file: "/project/src/other.ts", server });
  assert.equal(invalidatedAll, 0);
  plugin.handleHotUpdate?.({ file: "/project/src/content.config.ts", server });
  assert.equal(invalidatedAll, 1);
  assert.match(
    (await plugin.load("\0virtual:nimbus/config")) ?? "",
    /indexedCollections = \["docs","blog"\]/,
  );
});

test("declaresNoCollection is true only for a complete parse without the name", async () => {
  const dir = await mkdtemp(path.join(TEST_TMP, "nimbus-primary-absent-"));
  const file = path.join(dir, "content.config.ts");
  const absent = async (source: string | null) => {
    if (source === null) await rm(file, { force: true });
    else await writeFile(file, source);
    return declaresNoCollection(file, "docs");
  };
  try {
    assert.equal(await absent(`export const collections = { api: defineCollection(apiCollection()) };`), true);
    assert.equal(await absent(`export const collections = { docs: defineCollection({ loader: glob({ pattern: "**/*.md", base: "./docs" }) }) };`), false, "hand-written docs");
    assert.equal(await absent(`export const collections = {};\nconst registered = collections;\nregistered.docs = defineCollection({});`), false, "an alias");
    assert.equal(await absent(`export const collections = { ...shared, api: defineCollection(apiCollection()) };`), false, "a spread");
    assert.equal(await absent(`export const collections = makeCollections();`), false, "an unknown shape");
    assert.equal(await absent(null), false, "no file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the virtual config reports docs absent only when told, as in builds", async () => {
  const plugin = (extras: { getPrimaryCollectionAbsent?: () => Promise<boolean> }) =>
    virtualConfigPlugin({} as NimbusConfig, {
      getIndexedCollections: async () => [],
      requestRenderingCollections: [],
      base: "/",
      versionAlternates: {},
      apiCollections: [],
      collectionRoutes: new Map(),
      unreadCollectionRoutes: [],
      headDefaults: {
        favicon: { file: "/favicon.ico", type: "image/x-icon" },
        socialImage: "/opengraph.png",
        ogCard: { sitePath: "/og.png", pagePrefix: "/og/", size: { width: 1200, height: 630 } },
        imageSizes: {},
      },
      ...extras,
    });
  assert.match((await plugin({ getPrimaryCollectionAbsent: async () => true }).load("\0virtual:nimbus/config")) ?? "", /primaryCollectionAbsent = true;/);
  assert.match((await plugin({}).load("\0virtual:nimbus/config")) ?? "", /primaryCollectionAbsent = false;/);
});
