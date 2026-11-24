// A `bundle: false` API with path versions: a non-default version's pages
// make their own section indexes (`pp/v1/users/llms.txt`), as a bundled
// store's do, instead of landing in the default version's sections.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build, type AstroIntegration } from "astro";
import nimbus from "../src/index.ts";
import { runningNimbusVersion } from "../src/_internal/upgrades.ts";
import { TEST_TMP } from "./fixtures/temp-root.js";

const SRC_DIR = path.resolve(import.meta.dirname, "../src");

function spec(title: string): string {
  const operation = (id: string, tag: string) => ({
    operationId: id,
    tags: [tag],
    summary: id,
    responses: { "200": { description: "ok" } },
  });
  return JSON.stringify({
    openapi: "3.0.0",
    info: { title, version: "1.0.0" },
    tags: [{ name: "users" }, { name: "orders" }],
    paths: {
      "/users": { get: operation("list-users", "users"), post: operation("create-user", "users") },
      "/orders": { get: operation("list-orders", "orders") },
    },
  });
}

test("page packs: a path version's pages make their own section indexes", { timeout: 240_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(TEST_TMP, "nimbus-page-pack-versions-")));
  const write = async (file: string, body: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), body);
  };
  try {
    await symlink(path.resolve(import.meta.dirname, "../node_modules"), path.join(root, "node_modules"), "dir");
    await write("package.json", '{"type":"module"}');
    await write("nimbus.json", `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`);
    await write("specs/pp-v2.json", spec("pp v2"));
    await write("specs/pp-v1.json", spec("pp v1"));
    const content = pathToFileURL(path.join(SRC_DIR, "content.ts")).href;
    await write(
      "src/content.config.ts",
      `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection } from ${JSON.stringify(content)};
export const collections = { docs: defineCollection(docsCollection()), pp: defineCollection(apiCollection()) };`,
    );
    await write(
      "src/live.config.ts",
      `import { defineLiveCollection } from "astro:content";
import { apiPagesLoader } from "@cloudflare/nimbus-docs/live";
export const collections = { apiPages: defineLiveCollection({ loader: apiPagesLoader() }) };`,
    );
    await write("src/content/docs/guide.md", "---\ntitle: Guide\n---\n\nText.\n");
    await write("src/pages/index.astro", "<html><body><h1>Home</h1></body></html>\n");
    await write(
      "src/pages/[...slug].astro",
      `---
import { getDocsStaticPaths, getDocsPage } from "@cloudflare/nimbus-docs/runtime";
export const prerender = true;
export const getStaticPaths = getDocsStaticPaths;
const page = await getDocsPage(Astro);
if (page instanceof Response) return page;
---
<html><body>doc</body></html>
`,
    );
    await write(
      "src/pages/pp/[...slug].astro",
      `---
import { getApiRoute, getApiStaticPaths } from "@cloudflare/nimbus-docs/runtime";
export const getStaticPaths = getApiStaticPaths("pp");
const result = await getApiRoute(Astro);
if (result instanceof Response) return result;
---
<html><body>{result.page.title}</body></html>
`,
    );
    const endpoints = '"@cloudflare/nimbus-docs/agent-endpoints"';
    await write("src/pages/[...slug]/index.md.ts", `import { markdownRoute } from ${endpoints};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = markdownRoute();\n`);
    await write("src/pages/llms.txt.ts", `import { llmsRoute } from ${endpoints};\nexport const prerender = true;\nexport const { GET } = llmsRoute();\n`);
    await write("src/pages/[...section]/llms.txt.ts", `import { llmsSectionRoute } from ${endpoints};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = llmsSectionRoute();\n`);
    await write("src/pages/llms-full.txt.ts", `import { llmsFullRoute } from ${endpoints};\nexport const prerender = true;\nexport const { GET } = llmsFullRoute();\n`);
    await write("server-entry.mjs", 'import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n');
    const adapter: AstroIntegration = {
      name: "@astrojs/cloudflare",
      hooks: {
        "astro:config:done": ({ setAdapter }) => {
          setAdapter({
            name: "@astrojs/cloudflare",
            entrypointResolution: "auto",
            serverEntrypoint: path.join(root, "server-entry.mjs"),
            supportedAstroFeatures: { serverOutput: "stable" },
          });
        },
      },
    };
    await build({
      root: pathToFileURL(`${root}${path.sep}`),
      cacheDir: path.join(root, ".astro"),
      outDir: "./dist",
      build: { server: path.join(root, ".server"), client: path.join(root, "dist") },
      vite: {
        cacheDir: path.join(root, ".vite"),
        resolve: {
          alias: [
            { find: /^@cloudflare\/nimbus-docs$/, replacement: path.join(SRC_DIR, "index.ts") },
            { find: /^@cloudflare\/nimbus-docs\//, replacement: `${SRC_DIR}/` },
          ],
        },
      },
      output: "server",
      adapter,
      logLevel: "silent",
      integrations: [
        nimbus(
          {
            site: "https://example.test",
            title: "Test",
            search: false,
            rendering: { default: "build", collections: { pp: "request" } },
            api: [
              {
                collection: "pp",
                bundle: false,
                versions: [
                  { version: "v2", spec: "./specs/pp-v2.json", default: true },
                  { version: "v1", spec: "./specs/pp-v1.json" },
                ],
              },
            ],
          } as Parameters<typeof nimbus>[0],
          { admonitions: false, sitemap: false, validateMdx: false },
        ),
      ],
    } as never);

    const manifestPath = (await readdir(path.join(root, "dist"), { recursive: true }))
      .map((file) => path.join(root, "dist", file))
      .find((file) => file.endsWith(`${path.sep}agent-endpoint-assets${path.sep}manifest.json`));
    assert.ok(manifestPath, "a staged manifest");
    const manifest = JSON.parse(await readFile(manifestPath!, "utf8")) as {
      llmsAssets: Array<{ scope: string; surface: string; section?: string; path: string }>;
    };
    const indexes = manifest.llmsAssets.filter((asset) => asset.scope === "section" && asset.surface === "index");
    const sections = indexes.map((asset) => asset.section!).sort();
    assert.ok(sections.includes("pp/tags/users"), `the default version's users section among ${sections.join(", ")}`);
    assert.ok(sections.includes("pp/v1/tags/users"), `the v1 users section among ${sections.join(", ")}`);
    // The default version's group lists its own pages only; the v1 group its own.
    const bodyOf = async (section: string) =>
      readFile(path.join(path.dirname(manifestPath!), indexes.find((asset) => asset.section === section)!.path), "utf8");
    assert.doesNotMatch(await bodyOf("pp/tags/users"), /\/pp\/v1\//);
    assert.match(await bodyOf("pp/tags/users"), /\/pp\/users\/|\/pp\/list-users\//);
    assert.match(await bodyOf("pp/v1/tags/users"), /\/pp\/v1\//);
    assert.doesNotMatch(await bodyOf("pp/v1/tags/users"), /\(https:\/\/example\.test\/pp\/(?!v1\/)/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
