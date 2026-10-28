import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "astro";
import { JSDOM } from "jsdom";

import nimbus from "../src/index.js";
import { runningNimbusVersion } from "../src/_internal/upgrades.js";
import { srcModule, testAdapter } from "./fixtures/agent-site.js";
import { TEST_TMP } from "./fixtures/temp-root.js";

const sourceRoot = path.resolve(import.meta.dirname, "../src");
const rootUrls = ["https://example.test/docs", "https://example.test/docs/"];

for (const [trailingSlash, format, rootPath] of [
  ["always", "directory", "/docs/"],
  ["always", "file", "/docs/"],
  ["never", "directory", "/docs"],
  ["never", "file", "/docs"],
  ["ignore", "directory", "/docs/"],
  ["ignore", "file", "/docs"],
] as const) {
  for (const request of [false, true]) {
    test(`sitemap root matches the ${request ? "request-rendered" : "static"} canonical: ${trailingSlash}, ${format}`, { timeout: 30_000 }, async (t) => {
      const root = await realpath(await mkdtemp(path.join(TEST_TMP, "nimbus-sitemap-root-")));
      t.after(() => rm(root, { recursive: true, force: true }));
      const write = async (file: string, body: string) => {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), body);
      };
      await symlink(path.resolve(import.meta.dirname, "../node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      await write("package.json", '{"type":"module"}');
      await write("nimbus.json", JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() }));
      await write("src/pages/index.astro", `---
import NimbusHead from ${srcModule("components/NimbusHead.astro")};
export const prerender = ${!request};
---
<html><head><NimbusHead title="Home" /></head><body>Home</body></html>
`);
      if (request) {
        await write("server-entry.mjs", 'import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n');
        await write("src/content.config.ts", `import { defineCollection } from "astro:content";
import { docsCollection } from ${srcModule("content.ts")};
export const collections = { docs: defineCollection(docsCollection()) };
`);
        await write("src/content/docs/guide.md", "---\ntitle: Guide\n---\nGuide.\n");
        await write("src/pages/[...slug].astro", `---
import { getDocsPage } from ${srcModule("runtime.ts")};
const page = await getDocsPage(Astro);
if (page instanceof Response) return page;
---
<html><body>Guide</body></html>
`);
      }

      const serialized: string[] = [];
      await build({
        root: pathToFileURL(`${root}${path.sep}`),
        configFile: false,
        cacheDir: path.join(root, ".astro"),
        outDir: "./dist",
        base: "/docs",
        trailingSlash,
        build: { format, server: path.join(root, ".server"), client: path.join(root, "dist") },
        vite: {
          cacheDir: path.join(root, ".vite"),
          resolve: {
            alias: [
              { find: /^@cloudflare\/nimbus-docs$/, replacement: path.join(sourceRoot, "index.ts") },
              { find: /^@cloudflare\/nimbus-docs\//, replacement: `${sourceRoot}/` },
            ],
          },
        },
        ...(request ? { output: "server" as const, adapter: testAdapter(path.join(root, "server-entry.mjs")) } : {}),
        logLevel: "silent",
        integrations: [
          nimbus(
            {
              site: "https://example.test",
              title: "Test",
              search: false,
              ...(request ? { rendering: { collections: { docs: "request" as const } } } : {}),
            },
            {
              admonitions: false,
              validateMdx: false,
              sitemap: { serialize: (item) => { serialized.push(item.url); return item; } },
            },
          ),
        ],
      });

      let html: string;
      if (request) {
        const { app } = await import(pathToFileURL(path.join(root, ".server/entry.mjs")).href);
        const response = await app.render(new Request(`https://example.test${rootPath}`));
        assert.equal(response.status, 200);
        html = await response.text();
        if (trailingSlash !== "ignore") {
          const alias = rootPath === "/docs" ? "/docs/" : "/docs";
          const redirect = await app.render(new Request(`https://example.test${alias}`));
          assert.equal(redirect.status, 301);
          assert.equal(redirect.headers.get("location"), rootPath);
        }
      } else {
        html = await readFile(path.join(root, "dist/index.html"), "utf8");
      }

      const expected = `https://example.test${rootPath}`;
      const page = new JSDOM(html);
      try {
        assert.equal(page.window.document.querySelector('link[rel="canonical"]')?.getAttribute("href"), expected);
      } finally {
        page.window.close();
      }
      const sitemap = new JSDOM(await readFile(path.join(root, "dist/sitemap-0.xml"), "utf8"), { contentType: "text/xml" });
      try {
        const urls = [...sitemap.window.document.querySelectorAll("url > loc")].map((loc) => loc.textContent ?? "");
        assert.deepEqual(urls.filter((url) => rootUrls.includes(url)), [expected]);
      } finally {
        sitemap.window.close();
      }
      assert.deepEqual(serialized.filter((url) => rootUrls.includes(url)), [expected]);
    });
  }
}
