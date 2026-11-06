// Moving a route on a site with warm caches: the rebuild emits only the new
// URLs, API citations included.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";

import { agentSites, srcModule } from "./fixtures/agent-site.ts";

const sites = agentSites();
after(() => sites.cleanup());

const runtime = JSON.stringify("@cloudflare/nimbus-docs/runtime");
const endpoints = srcModule("agent-endpoints.ts");
const SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Pets", version: "1.0.0" },
  paths: { "/pets": { get: { operationId: "list-pets", summary: "List pets", responses: { "200": { description: "ok" } } } } },
});

const sdkRoute = `---
import { getCollectionStaticPaths, getCollectionPage } from ${runtime};
export const prerender = true;
export const getStaticPaths = getCollectionStaticPaths("sdk");
const page = await getCollectionPage(Astro);
if (page instanceof Response) return page;
---
<html><body>sdk</body></html>
`;
const apiRoute = `---
import { getApiRoute, getApiStaticPaths } from ${runtime};
export const prerender = true;
export const getStaticPaths = getApiStaticPaths("api");
const result = await getApiRoute(Astro);
if (result instanceof Response) return result;
---
<html><body>{result.page.title}</body></html>
`;

const FILES: Record<string, string> = {
  "src/content.config.ts": `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection } from ${srcModule("content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  sdk: defineCollection(docsCollection({ base: "sdk" })),
  api: defineCollection(apiCollection()),
};`,
  "src/content/docs/index.mdx": "---\ntitle: Home\n---\nSee [the pets list](api.ref:api:list-pets).\n",
  "src/content/sdk/setup.mdx": "---\ntitle: Setup\n---\nSet it up.\n",
  "specs/pets.json": SPEC,
  "src/pages/[...slug].astro": `---
import { getDocsStaticPaths, getDocsPage } from ${runtime};
export const prerender = true;
export const getStaticPaths = getDocsStaticPaths;
const page = await getDocsPage(Astro);
if (page instanceof Response) return page;
---
<html><body>doc</body></html>
`,
  "src/pages/sdk/[...slug].astro": sdkRoute,
  "src/pages/api/[...slug].astro": apiRoute,
  "src/pages/[...slug]/index.md.ts": `import { markdownRoute } from ${endpoints};
export const prerender = true;
export const { GET, getStaticPaths } = markdownRoute();
`,
};

test("moving routes on a warm cache rebuilds pages and citations at the new URLs", async () => {
  const options = { packageImports: true, api: [{ collection: "api", spec: "./specs/pets.json" }] };
  const { root } = await sites.buildSite(FILES, options);
  const read = (file: string) => readFile(path.join(root, "dist", file), "utf8");
  assert.match(await read("index.md"), /\[the pets list\]\(https:\/\/example\.test\/docs\/api\/list-pets\/\)/);

  await sites.buildSite(
    {
      "src/pages/sdk/[...slug].astro": null,
      "src/pages/api/[...slug].astro": null,
      "src/pages/products/kit/[...slug].astro": sdkRoute,
      "src/pages/reference/api/[...slug].astro": apiRoute,
    },
    { ...options, root },
  );
  assert.match(await read("index.md"), /\[the pets list\]\(https:\/\/example\.test\/docs\/reference\/api\/list-pets\/\)/);
  assert.match(await read("products/kit/setup/index.md"), /Set it up\./);
  for (const old of ["sdk", "api"]) assert.ok(!existsSync(path.join(root, "dist", old)), `nothing left at /${old}`);
});
