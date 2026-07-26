/**
 * Wiring guard: `astro:config:setup` must write the hashless prerender naming to
 * the NATIVE `vite.environments.prerender.build.rolldownOptions.output` (the key
 * Astro 7 reads), and must NOT touch it when the consumer already configured that
 * environment. A silent key regression here would quietly lose the build-time win
 * on large sites, so pin it end-to-end rather than only unit-testing the helper.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import nimbus from "../src/index.js";
import {
  PRERENDER_ENTRY_FILE_NAME,
  PRERENDER_CHUNK_FILE_NAME,
} from "../src/_internal/prerender-chunk-names.js";

const dirUrl = (p: string) => pathToFileURL(p + path.sep);

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "nimbus-prerender-"));
  const write = async (rel: string, body: string) => {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, "utf8");
  };
  await write("src/content/docs/index.md", "---\ntitle: Home\ndescription: D\n---\n\nHi.\n");
  await write(
    "src/content.config.ts",
    `import { docsCollection } from "@cloudflare/nimbus-docs/content";\nexport const collections = { docs: docsCollection({ base: "docs" }) };\n`,
  );
  await write("src/components.ts", "export const components = {\n  Aside: () => null,\n};\n");
  return root;
}

async function runConfigSetup(root: string, vite?: Record<string, unknown>) {
  const logger = {
    warn: () => {},
    info: () => {},
    error: () => {},
    debug: () => {},
    fork() {
      return logger;
    },
  };
  let updatedConfig: Record<string, any> | null = null;

  const integration = nimbus(
    { site: "https://example.test", title: "T", description: "D", locale: "en" } as never,
    { validateMdx: false, admonitions: false, sitemap: false, markdown: { processor: {} as never } },
  );
  const hook = integration.hooks["astro:config:setup"];
  assert.ok(hook, "integration exposes astro:config:setup");

  await hook!({
    updateConfig: (config: Record<string, unknown>) => {
      updatedConfig = config;
      return {} as never;
    },
    config: {
      root: dirUrl(root),
      srcDir: dirUrl(path.join(root, "src")),
      cacheDir: dirUrl(path.join(root, ".cache")),
      base: "",
      ...(vite ? { vite } : {}),
    },
    logger,
  } as never);

  return updatedConfig;
}

const prerenderOutput = (cfg: Record<string, any> | null) =>
  cfg?.vite?.environments?.prerender?.build?.rolldownOptions?.output;

test("writes hashless names to the native rolldownOptions key when unconfigured", async () => {
  const root = await fixture();
  const updated = await runConfigSetup(root);
  assert.deepEqual(prerenderOutput(updated), {
    entryFileNames: PRERENDER_ENTRY_FILE_NAME,
    chunkFileNames: PRERENDER_CHUNK_FILE_NAME,
  });
});

test("does not touch the prerender env when the consumer already configured its output", async () => {
  const root = await fixture();
  const updated = await runConfigSetup(root, {
    environments: {
      prerender: { build: { rolldownOptions: { output: { entryFileNames: "mine-[hash].mjs" } } } },
    },
  });
  // Guard against a vacuous pass: the hook must have run and produced a vite
  // config — it just must not add a competing prerender output block.
  assert.ok(updated?.vite?.plugins, "config:setup should update vite");
  assert.equal(updated?.vite?.environments, undefined);
});
