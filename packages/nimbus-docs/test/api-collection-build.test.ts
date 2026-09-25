// `astro build` gate for `api` entries: each must be indexed by an
// `apiCollection()` registered under its own collection key. A collection of
// that name from another loader, or the entry under a different key, fails
// the build with a message naming the Nimbus config and src/content.config.ts.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "astro";

import nimbus from "../src/index.ts";
import { runningNimbusVersion } from "../src/_internal/upgrades.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10 })),
  );
});

const moduleUrl = (relative: string) =>
  JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, relative)).href);
const SPEC = path.resolve(import.meta.dirname, "fixtures/api/smallco.yaml");

async function buildSite(collections: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-api-build-"));
  roots.push(root);
  const write = async (relative: string, contents: string) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents, "utf8");
  };
  await symlink(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await write(
    "nimbus.json",
    `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`,
  );
  await write(
    "src/content.config.ts",
    `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection } from ${moduleUrl("../src/content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
${collections}
};`,
  );
  await write("src/content/docs/guide.md", "---\ntitle: Guide\n---\n\nText.\n");
  await write("src/content/billing/intro.md", "---\ntitle: Intro\n---\n\nText.\n");
  await write(
    "src/pages/api-pages.txt.ts",
    `import { getCollection } from "astro:content";
export const prerender = true;
export async function GET() {
  return new Response((await getCollection("api")).map((entry) => entry.id).sort().join("\\n"));
}`,
  );

  await build({
    root: pathToFileURL(`${root}${path.sep}`),
    cacheDir: path.join(root, ".astro"),
    outDir: "./dist",
    vite: { cacheDir: path.join(root, ".vite") },
    logLevel: "silent",
    integrations: [
      nimbus(
        {
          site: "https://example.test",
          title: "Test",
          description: "Test",
          search: false,
          api: [{ collection: "api", spec: SPEC }],
        },
        { admonitions: false, sitemap: false, validateMdx: false },
      ),
    ],
  });
  return root;
}

test("a zero-argument apiCollection() under the entry's key builds", async () => {
  const root = await buildSite(`  api: defineCollection(apiCollection()),`);
  const ids = (await readFile(path.join(root, "dist/api-pages.txt"), "utf8")).split("\n");
  assert.ok(ids.includes("index") && ids.length > 1, `api pages: ${ids.join(", ")}`);
});

test("a collection under the entry's key from another loader fails the build", async () => {
  await assert.rejects(
    buildSite(`  api: defineCollection(docsCollection({ base: "billing" })),`),
    /the Nimbus config \(astro\.config\.\*\) declares the API collection "api" in `api`, but src\/content\.config\.ts registers api with a loader other than apiCollection\(\)/,
  );
});

test("an api entry with no collection key fails the build", async () => {
  await assert.rejects(
    buildSite(""),
    /declares the API collection "api" in `api`, but src\/content\.config\.ts registers no collection that indexes it\. Add api: defineCollection\(apiCollection\(\)\)/,
  );
});

test("an explicit entry registered under another key fails the build", async () => {
  await assert.rejects(
    buildSite(
      `  payments: defineCollection(apiCollection({ collection: "api", spec: ${JSON.stringify(SPEC)} })),`,
    ),
    /declares the API collection "api" in `api`, but src\/content\.config\.ts registers it under the key payments\. Register it as api: defineCollection\(apiCollection\(\)\)\./,
  );
});
