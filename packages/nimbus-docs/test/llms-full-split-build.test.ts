// An llms-full.txt over the size limit, end to end: the root becomes an index
// of per-section files, every link resolves (prebuilt and on request, under a
// base path), no written or staged file is over the limit, and the injected
// section route appears only beside a root llms-full.txt route.

import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import { agentSites, REQUEST_DOCS_PAGE, siteApp, srcModule } from "./fixtures/agent-site.ts";

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
const body = (word: string) => `${word} `.repeat(120);

const CONTENT = {
  "src/content.config.ts": `import { defineCollection } from "astro:content";
import { docsCollection } from ${srcModule("content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  changelog: defineCollection(docsCollection({ base: "changelog" })),
};`,
  "src/content/docs/index.mdx": "---\ntitle: Home\n---\nHome.\n",
  "src/content/docs/concepts/one.mdx": `---\ntitle: Concept one\n---\n${body("concept")}\n`,
  "src/content/docs/reference/functions/math.mdx": `---\ntitle: Math\n---\n${body("math")}\n`,
  "src/content/docs/reference/settings/one.mdx": `---\ntitle: Setting\n---\n${body("setting")}\n`,
  "src/content/changelog/first.mdx": `---\ntitle: First\n---\n${body("first")}\n`,
};

function routes(prerender: boolean, sectionFolder = "[...section]"): Record<string, string> {
  return {
    "src/pages/llms.txt.ts": `import { llmsRoute } from ${endpoints};
export const prerender = ${prerender};
export const { GET } = llmsRoute();
`,
    "src/pages/llms-full.txt.ts": `import { llmsFullRoute } from ${endpoints};
export const prerender = ${prerender};
export const { GET } = llmsFullRoute();
`,
    [`src/pages/${sectionFolder}/llms.txt.ts`]: `import { llmsSectionRoute } from ${endpoints};
export const prerender = ${prerender};
export const { GET, getStaticPaths } = llmsSectionRoute();
`,
  };
}

/** `/docs/a/llms-full.txt` → `a/llms-full.txt`, for every split link in a body. */
function fullLinks(text: string): string[] {
  return [...text.matchAll(/\(https:\/\/example\.test\/docs\/([^)]*llms-full\.txt)\)/gu)].map(([, url]) => url!);
}

async function crawl(read: (url: string) => Promise<string | null>): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const queue = ["llms-full.txt"];
  while (queue.length > 0) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    const text = await read(url);
    assert.notEqual(text, null, `${url} is linked but not served`);
    seen.set(url, text!);
    queue.push(...fullLinks(text!));
  }
  return seen;
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test("a default static site splits llms-full.txt, every link resolves, nothing is over the limit", async () => {
  const site = await sites.buildSite({ ...CONTENT, ...routes(true) });
  const dist = path.join(site.root, "dist");
  const files = await crawl(async (url) =>
    existsSync(path.join(dist, url)) ? readFile(path.join(dist, url), "utf8") : null,
  );
  assert.deepEqual([...files.keys()].sort(), [
    "changelog/llms-full.txt",
    "concepts/llms-full.txt",
    "llms-full.txt",
    "reference/functions/llms-full.txt",
    "reference/llms-full.txt",
    "reference/settings/llms-full.txt",
  ]);
  assert.match(files.get("llms-full.txt")!, /split by section/);
  assert.match(files.get("reference/functions/llms-full.txt")!, /# Math/);
  for (const file of filesUnder(dist).filter((file) => file.endsWith(".txt"))) {
    assert.ok(statSync(file).size <= LIMIT, `${path.relative(dist, file)} is ${statSync(file).size} bytes`);
  }
  assert.match(await readFile(path.join(dist, "llms.txt"), "utf8"), /split by section/);
});

test("the old [section] llms route splits the same way, linking the site llms.txt from deep sections", async () => {
  const site = await sites.buildSite({ ...CONTENT, ...routes(true, "[section]") });
  const deep = await readFile(path.join(site.root, "dist/reference/functions/llms-full.txt"), "utf8");
  assert.match(deep, /Index: https:\/\/example\.test\/docs\/llms\.txt/);
  assert.match(
    await readFile(path.join(site.root, "dist/reference/llms-full.txt"), "utf8"),
    /Index: https:\/\/example\.test\/docs\/reference\/llms\.txt/,
  );
});

test("on request, every split file is served and no staged copy is over the limit", async () => {
  const site = await sites.buildSite({ ...CONTENT, ...REQUEST_DOCS_PAGE, ...routes(false) }, { server: true, rendering: { default: "request" } });
  const app = await siteApp(site);
  const files = await crawl(async (url) => {
    const response = await app.render(new Request(`https://example.test/docs/${url}`));
    return response.status === 200 ? response.text() : null;
  });
  assert.equal(files.size, 6);
  for (const file of filesUnder(path.join(site.root, "dist/_nimbus/agent-endpoint-assets/assets"))) {
    assert.ok(statSync(file).size <= LIMIT, `${file} is ${statSync(file).size} bytes`);
  }
});

for (const [rendering, mountPrebuilt] of [
  [{ default: "build", collections: { changelog: "request" } }, false],
  [{ default: "request", collections: { changelog: "build" } }, true],
  [{ default: "request", collections: { docs: "build", changelog: "build" } }, true],
] as const) {
test(`a mount in another mode than the root llms-full.txt serves its own split files (${JSON.stringify(rendering)})`, async () => {
  const site = await sites.buildSite(
    {
      ...CONTENT,
      ...routes(true),
      "src/pages/[...slug].astro": `---\nimport { getDocsStaticPaths, getDocsPageProps } from ${srcModule("index.ts")};\nexport const prerender = true;\nexport const getStaticPaths = getDocsStaticPaths;\nawait getDocsPageProps(Astro);\n---\n<html><body>Page</body></html>`,
      "src/pages/changelog/[...slug].astro": `---\nimport { getCollectionPage, getCollectionStaticPaths } from ${srcModule("index.ts")};\nexport const getStaticPaths = getCollectionStaticPaths("changelog");\nconst page = await getCollectionPage(Astro);\nif (page instanceof Response) return page;\n---\n<html><body>Entry</body></html>`,
    },
    { server: true, rendering },
  );
  const app = await siteApp(site);
  const dist = path.join(site.root, "dist");
  assert.equal(existsSync(path.join(dist, "changelog/llms-full.txt")), mountPrebuilt);
  const files = await crawl(async (url) => {
    if (existsSync(path.join(dist, url))) return readFile(path.join(dist, url), "utf8");
    const response = await app.render(new Request(`https://example.test/docs/${url}`));
    return response.status === 200 ? response.text() : null;
  });
  assert.match(files.get("changelog/llms-full.txt")!, /# First/);
});
}

test("without a root llms-full.txt route nothing is injected or baked", async () => {
  const { ["src/pages/llms-full.txt.ts"]: _full, ...rest } = routes(true);
  const site = await sites.buildSite({ ...CONTENT, ...rest });
  assert.deepEqual(filesUnder(path.join(site.root, "dist")).filter((file) => file.endsWith("llms-full.txt")), []);
});

test("a project route at [...x]/llms-full.txt owns the section files", async () => {
  const site = await sites.buildSite({
    ...CONTENT,
    ...routes(true),
    "src/pages/[...part]/llms-full.txt.ts": `export const prerender = true;
export function getStaticPaths() { return [{ params: { part: "custom" } }]; }
export const GET = () => new Response("mine");
`,
  }, { logLevel: "warn" });
  // The project's own llms-full.txt route isn't another route shadowing it.
  assert.doesNotMatch(site.logs, /another route answers/);
  assert.equal(await readFile(path.join(site.root, "dist/custom/llms-full.txt"), "utf8"), "mine");
  assert.ok(!existsSync(path.join(site.root, "dist/reference/llms-full.txt")));
});
