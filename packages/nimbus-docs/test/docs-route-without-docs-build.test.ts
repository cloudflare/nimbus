// The starter's docs route on a site whose content.config.ts declares no
// `docs`: it builds with no docs pages. A `docs` that's declared but isn't a
// Nimbus page collection still fails, as does a config Nimbus can't read.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { agentSites } from "./fixtures/agent-site.ts";

const sites = agentSites();
after(() => sites.cleanup());

const runtime = JSON.stringify("@cloudflare/nimbus-docs/runtime");
const content = JSON.stringify("@cloudflare/nimbus-docs/content");

const FILES: Record<string, string> = {
  "src/content/guides/start.md": "---\ntitle: Start\n---\nStart.\n",
  "src/content/docs/intro.md": "---\ntitle: Intro\n---\nIntro.\n",
  // The starter's docs route.
  "src/pages/[...slug].astro": `---
import { getDocsPage, getDocsStaticPaths } from ${runtime};
export const getStaticPaths = getDocsStaticPaths;
const page = await getDocsPage(Astro);
if (page instanceof Response) return page;
---
<html><body>{page.entry.data.title}</body></html>
`,
  "src/pages/guides/[...slug].astro": `---
import { getCollectionPage, getCollectionStaticPaths } from ${runtime};
export const getStaticPaths = getCollectionStaticPaths("guides");
const page = await getCollectionPage(Astro, "guides");
if (page instanceof Response) return page;
---
<html><body>{page.entry.data.title}</body></html>
`,
};

const build = (contentConfig: string) =>
  sites.buildSite({ ...FILES, "src/content.config.ts": contentConfig }, { packageImports: true, logLevel: "warn", base: "/" });

const header = `import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";
import { docsCollection } from ${content};
const guides = defineCollection(docsCollection({ base: "guides" }));`;

test("with no docs declared, the starter's docs route builds no pages", async () => {
  const site = await build(`${header}\nexport const collections = { guides };`);
  assert.ok(existsSync(path.join(site.root, "dist/guides/start/index.html")), "the other collection builds");
  assert.ok(!existsSync(path.join(site.root, "dist/intro/index.html")), "no docs page");
});

const PAGE_COLLECTION_ERROR = /collection "docs" is not a Nimbus page collection/;

test("a docs declared as a plain collection still fails, naming the fix", async () => {
  await assert.rejects(
    build(`${header}\nexport const collections = { guides, docs: defineCollection({ loader: glob({ pattern: "**/*.md", base: "./src/content/docs" }), schema: z.object({ title: z.string() }) }) };`),
    PAGE_COLLECTION_ERROR,
  );
});

test("a config Nimbus can't read without docs fails as before", async () => {
  await assert.rejects(build(`${header}\nconst shared = { guides };\nexport const collections = { ...shared };`), PAGE_COLLECTION_ERROR);
});
