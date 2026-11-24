import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { agentEndpointHotUpdatePlugin } from "../src/_internal/agent-endpoint-assets.ts";

const root = path.resolve("/site");
const artifacts = { id: "artifacts" };
const capabilities = { id: "capabilities" };
const plugin = agentEndpointHotUpdatePlugin(root);
const environment = {
  moduleGraph: {
    idToModuleMap: new Map<string, unknown>([
      ["\0virtual:nimbus/agent-endpoint-assets", artifacts],
      ["\0virtual:nimbus/agent-endpoint-asset-loader", { id: "loader" }],
      ["\0virtual:nimbus/agent-capabilities", capabilities],
      ["/site/src/styles/global.css", { id: "css" }],
    ]),
  },
};
const update = (file: string, modules: unknown[] = []) =>
  plugin.hotUpdate.call({ environment }, { file: path.join(root, file), modules });

test("a content write no module imports refreshes the agent endpoint modules", () => {
  assert.deepEqual(update("src/content/docs/index.mdx"), [artifacts, capabilities]);
  assert.deepEqual(update(".astro/data-store.json"), [artifacts, capabilities]);
});

test("other updates keep Vite's own module list, so the browser still hot-updates", () => {
  assert.equal(update("src/styles/global.css"), undefined);
  assert.equal(update("src/content/docs/index.mdx", [{ id: "mdx" }]), undefined);
});
