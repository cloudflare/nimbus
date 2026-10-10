import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { stagedAssetPlugin } from "../src/_internal/staged-asset-plugin.ts";

function plugin(root: string, adapter = "@astrojs/node", isDev = false) {
  return stagedAssetPlugin({
    root: path.join(root, "absent-project"),
    base: "/base",
    adapterName: () => adapter,
    clientDirectory: () => path.join(root, "client"),
    serverDirectory: () => path.join(root, "server"),
    isDev: () => isDev,
  });
}
function load(instance: ReturnType<typeof plugin>): string {
  return (instance.load as Function).call(
    { environment: { name: "ssr" } },
    "\0virtual:nimbus/staged-asset-loader",
  );
}

test("Node emitted transport reads relocated client output at arbitrary chunk depth without project files", async () => {
  const original = await mkdtemp(path.join(os.tmpdir(), "nimbus-original-"));
  const relocated = await mkdtemp(path.join(os.tmpdir(), "nimbus-relocated-"));
  try {
    const instance = plugin(original);
    const generated = load(instance);
    const { code } = (instance.renderChunk as Function)(generated, {
      fileName: "chunks/nested/transport.mjs",
    });
    assert.ok(
      !code.includes(original),
      "project and output absolute paths must not ship",
    );
    await mkdir(path.join(relocated, "client/_nimbus/pages"), {
      recursive: true,
    });
    await mkdir(path.join(relocated, "server/chunks/nested"), {
      recursive: true,
    });
    await writeFile(
      path.join(relocated, "client/_nimbus/pages/record-aa.json"),
      '{"record":true}',
    );
    const modulePath = path.join(
      relocated,
      "server/chunks/nested/transport.mjs",
    );
    await writeFile(modulePath, code);
    const transport = await import(pathToFileURL(modulePath).href);
    assert.equal(
      await transport.readStagedAssetFile("_nimbus/pages/record-aa.json"),
      '{"record":true}',
    );
    // Missing locally: the reader falls back to the same-origin fetch.
    assert.equal(
      await transport.readStagedAssetFile("_nimbus/pages/record-bb.json"),
      null,
    );
  } finally {
    await rm(original, { recursive: true, force: true });
    await rm(relocated, { recursive: true, force: true });
  }
});

test("Workers production uses GET binding reads and contains no filesystem imports", () => {
  const generated = load(plugin("/tmp/unused", "@astrojs/cloudflare"));
  assert.match(generated, /cloudflare:workers/);
  assert.match(generated, /method: 'GET'/);
  assert.ok(!generated.includes("node:"));
});

test("other server adapters try staging through a guarded dynamic import, then the HTTP fallback", () => {
  const generated = load(plugin("/tmp/unused", "@astrojs/other-edge"));
  assert.ok(!/^import .*node:/m.test(generated), "no static Node import");
  assert.match(generated, /import\("node:fs\/promises"\)/);
  assert.match(generated, /catch \{ return null; \}/);
});

test("workerd dev uses middleware origin and does not import Node APIs", () => {
  const generated = load(plugin("/tmp/unused", "@astrojs/cloudflare", true));
  assert.match(generated, /localhost:5173/);
  assert.ok(!generated.includes("node:"));
  assert.ok(!generated.includes("cloudflare:workers"));
});

test("prerender selects the actual environment: workerd binding or build-time Node staging", () => {
  const instance = plugin("/tmp/fixture", "@astrojs/cloudflare");
  const worker = (instance.load as Function).call(
    {
      environment: {
        name: "prerender",
        config: { resolve: { conditions: ["workerd"] } },
      },
    },
    "\0virtual:nimbus/staged-asset-loader",
  );
  assert.match(worker, /cloudflare:workers/);
  assert.ok(!worker.includes("node:fs"));
  const node = (instance.load as Function).call(
    {
      environment: {
        name: "prerender",
        config: { resolve: { conditions: ["node"] } },
      },
    },
    "\0virtual:nimbus/staged-asset-loader",
  );
  assert.match(node, /node:fs/);
  assert.match(node, /\.astro/);
  assert.ok(!node.includes("cloudflare:workers"));
});
