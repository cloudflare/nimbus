import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { createServer, type Plugin, type RunnableDevEnvironment } from "vite";

import {
  devContentStorePlugin,
  STORE_MODULE_ID,
} from "../src/_internal/dev-content-store.ts";

const astroStandIn: Plugin = {
  name: "astro-stand-in",
  enforce: "pre",
  load: { filter: { id: /^\0astro:data-layer-content$/ }, handler: () => "export default 'astro'" },
};

const resolveStoreId: Plugin = {
  name: "resolve-store-id",
  resolveId: (id) => (id === "astro:data-layer-content" ? STORE_MODULE_ID : undefined),
};

test("the dev content store module reads the store file at run time", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-dev-content-store-"));
  const file = path.join(root, "data-store.json");
  await writeFile(file, JSON.stringify([{ docs: 1 }, "one"]));
  const plugin = devContentStorePlugin(file);
  const server = await createServer({
    configFile: false,
    logLevel: "silent",
    root,
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, ws: false, watch: null },
    plugins: [astroStandIn, resolveStoreId, plugin],
  });
  const errors = t.mock.method(console, "error", () => undefined);
  try {
    const ssr = server.environments.ssr as RunnableDevEnvironment;
    const load = () =>
      ssr.runner.import("astro:data-layer-content").then((module) => module.default);
    const invalidate = () => {
      const module = ssr.moduleGraph.getModuleById(STORE_MODULE_ID);
      if (module) ssr.moduleGraph.invalidateModule(module, undefined, Date.now(), true);
      const evaluated = ssr.runner.evaluatedModules.getModuleById(STORE_MODULE_ID);
      if (evaluated) ssr.runner.evaluatedModules.invalidateModule(evaluated);
    };

    assert.deepEqual(await load(), [{ docs: 1 }, "one"]);
    assert.doesNotMatch(
      ssr.moduleGraph.getModuleById(STORE_MODULE_ID)!.transformResult!.code,
      /"one"/,
    );

    await writeFile(file, JSON.stringify([{ docs: 1 }, "two"]));
    invalidate();
    assert.deepEqual(await load(), [{ docs: 1 }, "two"]);

    await writeFile(file, "{");
    invalidate();
    await assert.rejects(load());
    assert.equal(errors.mock.callCount(), 1);
    assert.match(String(errors.mock.calls[0]!.arguments[0]), /couldn't read the content store/);

    const handler = (plugin.load as { handler: (this: unknown, id: string) => unknown }).handler;
    assert.equal(handler.call({ environment: ssr }, "\0other"), undefined);
    assert.equal(handler.call({ environment: {} }, STORE_MODULE_ID), undefined);
    await unlink(file);
    assert.equal(handler.call({ environment: ssr }, STORE_MODULE_ID), undefined);
  } finally {
    await server.close();
    await rm(root, { recursive: true });
  }
});

test("the store module id is Astro's", async () => {
  const astro = path.dirname(createRequire(import.meta.url).resolve("astro/package.json"));
  const consts = await import(pathToFileURL(path.join(astro, "dist/content/consts.js")).href);
  assert.equal(consts.RESOLVED_DATA_STORE_VIRTUAL_ID, STORE_MODULE_ID);
});
