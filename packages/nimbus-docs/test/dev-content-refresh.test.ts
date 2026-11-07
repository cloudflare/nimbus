// In `astro dev`, a content change reaches the runners that render pages.

import assert from "node:assert/strict";
import { test } from "node:test";

import { invalidateDevModules, refreshDevRunners } from "../src/_internal/dev-invalidation.js";

function fakeServer() {
  const calls: string[] = [];
  const environment = (name: string) => ({
    moduleGraph: {
      getModuleById: () => undefined,
      invalidateModule: () => {},
      invalidateAll: () => calls.push(`${name}:invalidate`),
    },
    hot: { send: (payload: { type: string }) => calls.push(`${name}:${payload.type}`) },
  });
  return {
    calls,
    server: {
      moduleGraph: environment("compat").moduleGraph,
      environments: { client: environment("client"), ssr: environment("ssr"), prerender: environment("prerender") },
    },
  };
}

test("refreshing the runners invalidates every graph and reloads the page renderers, not the browser", () => {
  const { calls, server } = fakeServer();
  refreshDevRunners(server);
  assert.deepEqual(calls.sort(), [
    "client:invalidate",
    "prerender:full-reload",
    "prerender:invalidate",
    "ssr:full-reload",
    "ssr:invalidate",
  ]);
});

test("invalidating alone still reloads nothing", () => {
  const { calls, server } = fakeServer();
  invalidateDevModules(server);
  assert.ok(calls.every((call) => call.endsWith(":invalidate")));
});
