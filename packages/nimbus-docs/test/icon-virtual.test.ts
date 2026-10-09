import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { iconVirtualPlugin } from "../src/_internal/icon-virtual.ts";

test("icon sets resolve from the site root, not the process's working directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nimbus-icons-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "@iconify-json/demo": "1.0.0" } }),
    );
    const set = path.join(root, "node_modules/@iconify-json/demo");
    await mkdir(set, { recursive: true });
    await writeFile(
      path.join(set, "package.json"),
      JSON.stringify({ name: "@iconify-json/demo", version: "1.0.0" }),
    );
    await writeFile(
      path.join(set, "icons.json"),
      JSON.stringify({
        prefix: "demo",
        icons: { star: { body: '<path d="M0 0"/>' } },
      }),
    );
    assert.notEqual(process.cwd(), root);
    const plugin = iconVirtualPlugin({ root });
    const code = await plugin.load(plugin.resolveId("virtual:nimbus/icons")!);
    assert.match(code!, /"demo"/);
    assert.match(code!, /"star"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
