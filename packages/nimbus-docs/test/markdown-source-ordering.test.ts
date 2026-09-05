import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";

import mdx from "@astrojs/mdx";
import { build, type AstroIntegration } from "astro";

import { markdownSourcePlugin } from "../src/_internal/markdown-source-vite-plugin.ts";
import { getPreparedMarkdownSnapshot } from "../src/_internal/prepared-markdown-registry.ts";
import nimbus from "../src/index.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

function sourceIntegration(contentDir: string): AstroIntegration {
  return {
    name: "test:markdown-source",
    hooks: {
      "astro:config:setup": ({ updateConfig }) => {
        updateConfig({
          vite: {
            plugins: [
              markdownSourcePlugin({
                contentDirs: [contentDir],
                transform: (source) => source.replace("/guide", "/docs/guide"),
              }),
            ],
          },
        });
      },
    },
  };
}

async function buildFixture(sourceFirst: boolean): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-mdx-order-"));
  temporaryRoots.push(root);
  await symlink(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const pages = path.join(root, "src/pages");
  await mkdir(pages, { recursive: true });
  await writeFile(path.join(pages, "index.mdx"), "[Guide](/guide)\n", "utf8");

  const source = sourceIntegration(path.join(root, "src"));
  const integrations = sourceFirst ? [source, mdx()] : [mdx(), source];
  await build({
    root: pathToFileURL(`${root}${path.sep}`),
    cacheDir: path.join(root, ".astro"),
    outDir: "./dist",
    build: { server: path.join(root, ".server") },
    vite: { cacheDir: path.join(root, ".vite") },
    integrations,
    logLevel: "silent",
  });

  return readFile(path.join(root, "dist/index.html"), "utf8");
}

test("MDX source normalization precedes compilation in either integration order", async () => {
  assert.match(await buildFixture(true), /href="\/docs\/guide"/);
  assert.match(await buildFixture(false), /href="\/docs\/guide"/);
});

test("MDX source adapter ignores virtual, queried, and missing files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-mdx-source-"));
  temporaryRoots.push(root);
  const sourcePath = path.join(root, "source.mdx");
  await writeFile(sourcePath, "unchanged", "utf8");
  const plugin = markdownSourcePlugin({
    contentDirs: [root],
    transform: (source) => source,
  });

  assert.equal(await plugin.transform("virtual", "\0virtual.mdx"), null);
  assert.equal(await plugin.transform("raw", `${sourcePath}?raw`), null);
  assert.equal(
    await plugin.transform("missing", path.join(root, "missing.mdx")),
    null,
  );
  assert.deepEqual(await plugin.transform("unchanged", sourcePath), {
    code: "unchanged",
    map: null,
  });
});

test("MDX source adapter rejects symlinks outside its content directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-mdx-symlink-"));
  temporaryRoots.push(root);
  const contentDir = path.join(root, "content");
  const outside = path.join(root, "outside.mdx");
  const linked = path.join(contentDir, "linked.mdx");
  await mkdir(contentDir);
  await writeFile(outside, "[Guide](/guide)", "utf8");
  await symlink(outside, linked);
  const plugin = markdownSourcePlugin({
    contentDirs: [contentDir],
    transform: (source) => source,
  });

  await assert.rejects(
    plugin.transform("[Guide](/guide)", linked),
    /resolves outside its content directory/,
  );
});

test("Nimbus production wiring normalizes Markdown and MDX compilation", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "nimbus-authored-integration-"),
  );
  temporaryRoots.push(root);
  await symlink(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await mkdir(path.join(root, "src/content/docs"), { recursive: true });
  await mkdir(path.join(root, "src/pages"), { recursive: true });
  await writeFile(
    path.join(root, "src/content.config.ts"),
    `import { defineCollection } from "astro:content";
import { docsCollection } from ${JSON.stringify(
      pathToFileURL(path.resolve(import.meta.dirname, "../src/content.ts"))
        .href,
    )};
export const collections = { docs: defineCollection(docsCollection()) };`,
    "utf8",
  );
  await writeFile(
    path.join(root, "src/content/docs/markdown.md"),
    "---\ntitle: Markdown\n---\n[Markdown](/guide)",
    "utf8",
  );
  await writeFile(
    path.join(root, "src/content/docs/mdx.mdx"),
    "---\ntitle: MDX\n---\n[MDX](/guide)",
    "utf8",
  );
  await writeFile(
    path.join(root, "src/pages/direct.mdx"),
    "[Direct](/guide)",
    "utf8",
  );
  await writeFile(
    path.join(root, "src/pages/index.astro"),
    `---
import { getCollection, render } from "astro:content";
const entries = await getCollection("docs");
const rendered = await Promise.all(entries.map((entry) => render(entry)));
---
{rendered.map(({ Content }) => <Content />)}`,
    "utf8",
  );

  let buildStartBodies: string[] = [];
  const registryProbe: AstroIntegration = {
    name: "test:prepared-markdown-registry",
    hooks: {
      "astro:build:start": () => {
        const entries =
          getPreparedMarkdownSnapshot(root)?.collections.get("docs")?.entries;
        buildStartBodies = entries
          ? [...entries.values()].map((entry) => entry.body ?? "")
          : [];
      },
    },
  };
  await build({
    root: pathToFileURL(`${root}${path.sep}`),
    cacheDir: path.join(root, ".astro"),
    outDir: "./dist",
    build: { server: path.join(root, ".server") },
    vite: { cacheDir: path.join(root, ".vite") },
    base: "/docs",
    logLevel: "silent",
    integrations: [
      nimbus(
        {
          site: "https://example.test",
          title: "Test",
          description: "Test",
          locale: "en",
          search: false,
        },
        { admonitions: false, sitemap: false, validateMdx: false },
      ),
      registryProbe,
    ],
  });

  const html = await readFile(path.join(root, "dist/index.html"), "utf8");
  assert.match(html, /href="\/docs\/guide"[^>]*>Markdown/);
  assert.match(html, /href="\/docs\/guide"[^>]*>MDX/);
  const directHtml = await readFile(
    path.join(root, "dist/direct/index.html"),
    "utf8",
  );
  assert.match(directHtml, /href="\/docs\/guide"[^>]*>Direct/);
  assert.deepEqual(buildStartBodies.sort(), [
    "[MDX](/docs/guide)",
    "[Markdown](/docs/guide)",
  ]);
});
