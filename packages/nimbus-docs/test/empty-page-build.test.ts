import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "astro";

import nimbus from "../src/index.js";
import { runningNimbusVersion } from "../src/_internal/upgrades.js";
import { TEST_TMP } from "./fixtures/temp-root.js";

const module = (file: string) =>
  JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../src", file)).href);

test("a page with only frontmatter builds", async () => {
  const root = await realpath(await mkdtemp(path.join(TEST_TMP, "nimbus-empty-")));
  const write = async (file: string, body: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), body);
  };
  try {
    await symlink(path.resolve(import.meta.dirname, "../node_modules"), path.join(root, "node_modules"), "dir");
    await write("package.json", '{"type":"module"}');
    await write("nimbus.json", JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() }));
    await write(
      "src/content.config.ts",
      `import { defineCollection } from "astro:content";
import { docsCollection } from ${module("content.ts")};
export const collections = { docs: defineCollection(docsCollection()) };
`,
    );
    await write("src/components.ts", "export const components = {};\n");
    await write("src/content/docs/coming-soon.mdx", "---\ntitle: Coming soon\n---\n");
    await write(
      "src/pages/[...slug].astro",
      `---
import { getDocsStaticPaths, getDocsPageProps } from ${module("runtime.ts")};
export const prerender = true;
export const getStaticPaths = getDocsStaticPaths;
const { entry, Content } = await getDocsPageProps(Astro);
---
<html><head><title>{entry.data.title}</title></head><body><Content /></body></html>
`,
    );
    await write(
      "src/pages/[...slug]/index.md.ts",
      `import { markdownRoute } from ${module("agent-endpoints.ts")};
export const prerender = true;
export const { GET, getStaticPaths } = markdownRoute();
`,
    );
    // The Source line names the .mdx version only where a route serves it.
    await write(
      "src/pages/[...slug]/index.mdx.ts",
      `import { markdownSourceRoute } from ${module("agent-endpoints.ts")};
export const prerender = true;
export const { GET, getStaticPaths } = markdownSourceRoute();
`,
    );
    await build({
      root: pathToFileURL(root + path.sep),
      configFile: false,
      cacheDir: path.join(root, ".astro"),
      vite: { cacheDir: path.join(root, ".vite") },
      logLevel: "silent",
      integrations: [nimbus({ site: "https://example.test", title: "Example", search: false }, { sitemap: false, icons: false })],
    });
    const markdown = await readFile(path.join(root, "dist/coming-soon/index.md"), "utf8");
    assert.match(markdown, /# Coming soon\n\nSource: https:\/\/example\.test\/coming-soon\/index\.mdx\n$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
