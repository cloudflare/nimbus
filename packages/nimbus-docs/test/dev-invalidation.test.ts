// Dev invalidation reaches every Vite environment, not only the client and
// `ssr` graphs behind `server.moduleGraph` (the Cloudflare adapter runs
// prerendered routes in its own `prerender` environment).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { invalidateDevModules, invalidatePreparedModules } from "../src/_internal/dev-invalidation.ts";
import {
  agentEndpointAssetsRuntimePlugin,
  configureAgentEndpointAssetRoot,
  preparedHeadingsPlugin,
} from "../src/_internal/agent-endpoint-assets.ts";
import { iconVirtualPlugin } from "../src/_internal/icon-virtual.ts";
import { virtualConfigPlugin } from "../src/_internal/virtual-config.ts";
import type { NimbusConfig } from "../src/types.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A graph that holds `loaded` modules and records what was invalidated. */
function graph(loaded: string[] = []) {
  const record = { all: 0, modules: [] as string[] };
  return {
    record,
    moduleGraph: {
      getModuleById: (id: string) => (loaded.includes(id) ? { id } : undefined),
      invalidateModule: (module: never) => void record.modules.push((module as { id: string }).id),
      invalidateAll: () => void record.all++,
      idToModuleMap: new Map(loaded.map((id) => [id, { id }])),
    },
  };
}

function server(loaded: Record<string, string[]> = {}) {
  const graphs = Object.fromEntries(["client", "ssr", "prerender"].map((name) => [name, graph(loaded[name])]));
  return {
    graphs,
    server: {
      // The compatibility view: invalidating it must not count as reaching the others.
      moduleGraph: graph().moduleGraph,
      environments: Object.fromEntries(Object.entries(graphs).map(([name, g]) => [name, { moduleGraph: g.moduleGraph }])),
    },
  };
}

test("a content edit invalidates only the prepared modules, in every environment", () => {
  const prepared = [
    "\0virtual:nimbus/agent-endpoint-assets",
    "\0virtual:nimbus/headings",
    "\0virtual:nimbus/headings/eyJhIjoxfQ",
    "\0virtual:nimbus/agent-capabilities",
  ];
  const others = ["\0virtual:nimbus/agent-endpoint-asset-loader", "\0virtual:nimbus/config", "/src/pages/index.astro"];
  const site = server({ ssr: [...prepared, ...others], prerender: [prepared[0]!, others[1]!] });
  invalidatePreparedModules(site.server);
  assert.deepEqual(
    Object.fromEntries(Object.entries(site.graphs).map(([name, g]) => [name, [g.record.all, g.record.modules]])),
    { client: [0, []], ssr: [0, prepared], prerender: [0, [prepared[0]]] },
  );
});

test("the helper invalidates every environment's graph, whole or by id", () => {
  const whole = server();
  invalidateDevModules(whole.server);
  assert.deepEqual(Object.values(whole.graphs).map((g) => g.record.all), [1, 1, 1]);

  const byId = server({ ssr: ["a"], prerender: ["a", "b"] });
  invalidateDevModules(byId.server, ["a", "b"]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(byId.graphs).map(([name, g]) => [name, g.record.modules])),
    { client: [], ssr: ["a"], prerender: ["a", "b"] },
  );
});

test("a content.config.ts edit invalidates every environment", () => {
  const plugin = virtualConfigPlugin({} as NimbusConfig, {
    getIndexedCollections: async () => ["docs"],
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
  const { graphs, server: dev } = server();
  plugin.handleHotUpdate!({ file: "/project/src/content.config.ts", server: dev });
  assert.deepEqual(Object.values(graphs).map((g) => g.record.all), [1, 1, 1]);
});

test("an icon edit invalidates every environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-dev-invalidation-"));
  roots.push(root);
  const plugin = iconVirtualPlugin({ root, include: {} });
  let onChange: ((event: string, file: string) => void) | undefined;
  const { graphs, server: dev } = server();
  plugin.configureServer!({ ...dev, watcher: { add: () => {}, on: (_event, callback) => void (onChange = callback) } });
  onChange!("change", path.join(root, "src/icons/star.svg"));
  assert.deepEqual(Object.values(graphs).map((g) => g.record.all), [1, 1, 1]);
});

test("Markdown assets and a lazy heading loaded in two environments are invalidated in both", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-dev-invalidation-"));
  roots.push(root);
  configureAgentEndpointAssetRoot(root, "dev", async () => {
    throw new Error("not baked in this test");
  }, undefined, "/", async () => null);
  const headings = preparedHeadingsPlugin(root);
  const entry = `\0virtual:nimbus/headings/${Buffer.from(JSON.stringify(["docs", "guide"])).toString("base64url")}`;
  await headings.load.call({}, entry);

  const loaded = ["\0virtual:nimbus/headings", entry, "\0virtual:nimbus/agent-endpoint-assets"];
  const first = server({ ssr: loaded, prerender: loaded });
  headings.handleHotUpdate({ server: first.server });
  agentEndpointAssetsRuntimePlugin(root).handleHotUpdate({ server: first.server });
  for (const name of ["ssr", "prerender"]) {
    assert.deepEqual(first.graphs[name]!.record.modules, loaded, name);
  }

  // The entry list was cleared once, after every graph saw it.
  const second = server({ ssr: loaded, prerender: loaded });
  headings.handleHotUpdate({ server: second.server });
  assert.deepEqual(second.graphs.prerender!.record.modules, ["\0virtual:nimbus/headings"]);
});
