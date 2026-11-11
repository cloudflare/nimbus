// Nested and split agent files across rendering modes: every file a
// build-mode route owns is in `dist`, every request-mode one is served on
// request (never through a `dist` fallback), the old `[section]` route never
// answers a mount's `llms-full.txt`, and an over-limit file warns on a
// Cloudflare deploy.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import { agentManifest, agentSites, siteApp, srcModule } from "./fixtures/agent-site.ts";

const LIMIT = 1500;
before(() => {
  process.env.NIMBUS_TEST_LLMS_FULL_LIMIT_BYTES = String(LIMIT);
});
after(() => {
  delete process.env.NIMBUS_TEST_LLMS_FULL_LIMIT_BYTES;
});

const sites = agentSites();
afterEach(() => sites.cleanup());

const endpoints = srcModule("agent-endpoints.ts");
const index = srcModule("index.ts");
const body = (word: string) => `${word} `.repeat(120);

const CONTENT = {
  "src/content.config.ts": `import { defineCollection } from "astro:content";
import { docsCollection } from ${srcModule("content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  changelog: defineCollection(docsCollection({ base: "changelog" })),
  blog: defineCollection(docsCollection({ base: "blog" })),
};`,
  "src/content/docs/index.mdx": "---\ntitle: Home\n---\nHome.\n",
  "src/content/docs/concepts/one.mdx": `---\ntitle: Concept one\n---\n${body("concept")}\n`,
  "src/content/docs/reference/functions/math.mdx": `---\ntitle: Math\n---\n${body("math")}\n`,
  "src/content/changelog/first.mdx": `---\ntitle: First\n---\n${body("first")}\n`,
  "src/content/changelog/2024/launch.mdx": `---\ntitle: Launch\n---\n${body("launch")}\n`,
  "src/content/blog/hello.mdx": `---\ntitle: Hello\n---\n${body("hello")}\n`,
  "src/content/blog/news/today.mdx": `---\ntitle: Today\n---\n${body("today")}\n`,
  "src/pages/[...slug].astro": `---\nimport { getDocsStaticPaths, getDocsPageProps } from ${index};\nexport const prerender = true;\nexport const getStaticPaths = getDocsStaticPaths;\nawait getDocsPageProps(Astro);\n---\n<html><body>Page</body></html>`,
  "src/pages/changelog/[...slug].astro": `---\nimport { getCollectionPage, getCollectionStaticPaths } from ${index};\nexport const getStaticPaths = getCollectionStaticPaths("changelog");\nconst page = await getCollectionPage(Astro);\nif (page instanceof Response) return page;\n---\n<html><body>Entry</body></html>`,
  "src/pages/blog/[...slug].astro": `---\nimport { getCollectionPage, getCollectionStaticPaths } from ${index};\nexport const getStaticPaths = getCollectionStaticPaths("blog");\nconst page = await getCollectionPage(Astro);\nif (page instanceof Response) return page;\n---\n<html><body>Post</body></html>`,
};

function agentRoutes(sectionFolder: string): Record<string, string> {
  const route = (factory: string, extra = "") =>
    `import { ${factory} } from ${endpoints};\nexport const prerender = true;\nexport const { GET${extra} } = ${factory}();\n`;
  return {
    // Page Markdown is built only where a route serves it.
    "src/pages/[...slug]/index.md.ts": route("markdownRoute", ", getStaticPaths"),
    "src/pages/llms.txt.ts": route("llmsRoute"),
    "src/pages/llms-full.txt.ts": route("llmsFullRoute"),
    [`src/pages/${sectionFolder}/llms.txt.ts`]: route("llmsSectionRoute", ", getStaticPaths"),
  };
}

/** The URL of every baked llms file. */
async function llmsUrls(root: string): Promise<string[]> {
  return (await agentManifest(root)).llmsAssets.map((asset) =>
    asset.scope === "site"
      ? asset.surface === "full"
        ? "llms-full.txt"
        : "llms.txt"
      : `${asset.section}/${asset.surface === "full" ? "llms-full.txt" : "llms.txt"}`,
  );
}

const modeOf = (url: string, rendering: { default: string; collections: Record<string, string> }) =>
  rendering.collections[url.split("/")[0]!] ?? rendering.default;

for (const rendering of [
  { default: "build", collections: { changelog: "request", blog: "build" } },
  { default: "request", collections: { changelog: "build", blog: "request" } },
  { default: "build", collections: { changelog: "request", blog: "request" } },
  { default: "request", collections: { changelog: "build", blog: "build" } },
] as const) {
  test(`mixed modes ${JSON.stringify(rendering)}: build files are in dist, request files are served`, async () => {
    const site = await sites.buildSite(
      { ...CONTENT, ...agentRoutes("[...section]") },
      { server: true, rendering, logLevel: "warn" },
    );
    assert.doesNotMatch(site.logs, /not prerendered/);
    const app = await siteApp(site);
    const urls = await llmsUrls(site.root);
    assert.ok(urls.includes("changelog/2024/llms.txt") && urls.includes("changelog/llms-full.txt"), urls.join(", "));
    for (const url of urls) {
      const inDist = existsSync(path.join(site.root, "dist", url));
      if (modeOf(url, rendering as never) === "build") {
        assert.ok(inDist, `${url} should be prebuilt`);
      } else {
        assert.ok(!inDist, `${url} should render on request`);
        const response = await app.render(new Request(`https://example.test/docs/${url}`));
        assert.equal(response.status, 200, url);
      }
    }
  });
}

test("old [section] route with a policy, a mount and a split: the mount's llms-full.txt is the split file", async () => {
  const site = await sites.buildSite(
    { ...CONTENT, ...agentRoutes("[section]") },
    { server: true, rendering: { default: "build", collections: { changelog: "request", blog: "build" } } },
  );
  const app = await siteApp(site);
  const full = await app.render(new Request("https://example.test/docs/changelog/llms-full.txt"));
  assert.equal(full.status, 200);
  assert.match(await full.text(), /^# Test — Changelog\n/);
  const index = await app.render(new Request("https://example.test/docs/changelog/llms.txt"));
  assert.equal(index.status, 200);
  assert.match(await index.text(), /^# Changelog\n/);
  // The old route bakes flat sections, so there's no nested index to serve.
  assert.equal((await app.render(new Request("https://example.test/docs/changelog/2024/llms.txt"))).status, 404);
});

test("a project <mount>/[llms].txt still owns the mount's index", async () => {
  const site = await sites.buildSite(
    {
      ...CONTENT,
      ...agentRoutes("[section]"),
      "src/pages/changelog/[llms].txt.ts": `export const prerender = false;\nexport const GET = () => new Response("mine");\n`,
    },
    {
      server: true,
      rendering: { default: "build", collections: { changelog: "request", blog: "build" } },
      logLevel: "warn",
    },
  );
  const app = await siteApp(site);
  assert.equal(await (await app.render(new Request("https://example.test/docs/changelog/llms.txt"))).text(), "mine");
  // Its [llms] parameter also matches llms-full, so the split file there is
  // never served: the build says so, once.
  assert.match(
    site.logs,
    /another route answers some of its files[\s\S]*src\/pages\/changelog\/\[llms\]\.txt\.ts \(\/changelog\/\[llms\]\.txt\) answers \/changelog\/llms-full\.txt/,
  );
  assert.doesNotMatch(site.logs, /not prerendered/);
});

test("on a static build, a project <mount>/[llms].txt hiding a split file is named, not silently 404", async () => {
  const site = await sites.buildSite(
    {
      ...CONTENT,
      ...agentRoutes("[...section]"),
      "src/pages/changelog/[llms].txt.ts": `export const prerender = true;\nexport const getStaticPaths = () => [{ params: { llms: "llms" } }];\nexport const GET = () => new Response("mine");\n`,
    },
    { logLevel: "warn" },
  );
  assert.ok(!existsSync(path.join(site.root, "dist/changelog/llms-full.txt")));
  assert.match(site.logs, /src\/pages\/changelog\/\[llms\]\.txt\.ts \(\/changelog\/\[llms\]\.txt\) answers \/changelog\/llms-full\.txt/);
  assert.match(site.logs, /a route that serves one llms\.txt is `llms\.txt\.ts`/);
  assert.doesNotMatch(site.logs, /not prerendered/);
});

test("a static Cloudflare site with no adapter warns about a page over the limit", async () => {
  const site = await sites.buildSite(
    {
      ...CONTENT,
      ...agentRoutes("[...section]"),
      "src/content/docs/concepts/huge.mdx": `---\ntitle: Huge\n---\n${body("huge").repeat(3)}\n`,
      "wrangler.jsonc": `{ "name": "docs", "assets": { "directory": "./dist" } }\n`,
    },
    { logLevel: "warn" },
  );
  assert.match(site.logs, /\/concepts\/huge\/index\.md is \d+ KiB, over Cloudflare's 25 MiB file limit, so the deploy will fail\./);
  assert.doesNotMatch(site.logs, /llms-full\.txt is \d+ KiB, over/);
  assert.match(await readFile(path.join(site.root, "dist/concepts/llms-full.txt"), "utf8"), /split further|- \[Huge\]/);
});
