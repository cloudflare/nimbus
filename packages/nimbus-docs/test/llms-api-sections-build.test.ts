// With nested `llms.txt` sections, an API operation is listed in its tag's
// index, as the sidebar groups it, even when its URL isn't under the tag
// (`resource-action-v2` serves `/users/list` and the tag at `/tags/users`).
// Each version follows its own nav: the same operation is under a different
// tag in v1. A static build reads the nav from the API model; a request-
// rendered API from its prepared pages.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { after, before, test } from "node:test";

import { agentSites, siteApp, srcModule } from "./fixtures/agent-site.ts";

// The request-rendered site reads its manifest and page records through the
// Workers assets binding: stub it to read `dist/`.
register(new URL("./fixtures/mcp/workers-loader.mjs", import.meta.url));
const assetRoots = ((globalThis as { __nimbusTestAssetRoots?: Map<string, { dir: string; base: string }> }).__nimbusTestAssetRoots ??= new Map());
import { TEST_TMP } from "./fixtures/temp-root.js";

const sites = agentSites();
after(() => sites.cleanup());

const runtime = JSON.stringify("@cloudflare/nimbus-docs/runtime");
const endpoints = JSON.stringify("@cloudflare/nimbus-docs/agent-endpoints");
const ok = { "200": { description: "ok" } };

const spec = (title: string, usersTag: string) => ({
  openapi: "3.1.0",
  info: { title, version: "1" },
  tags: [{ name: usersTag }, { name: "Billing" }],
  paths: {
    "/users": {
      get: { operationId: "usersList", summary: "List users", tags: [usersTag], responses: ok },
      post: { operationId: "usersCreate", summary: "Create user", tags: [usersTag], responses: ok },
    },
    "/invoices": { get: { operationId: "invoicesList", summary: "List invoices", tags: ["Billing"], responses: ok } },
  },
});

let specDir = "";
before(async () => {
  specDir = await mkdtemp(path.join(TEST_TMP, "nimbus-llms-api-sections-"));
  await writeFile(path.join(specDir, "v2.json"), JSON.stringify(spec("Accounts v2", "Users")));
  await writeFile(path.join(specDir, "v1.json"), JSON.stringify(spec("Accounts v1", "Accounts")));
});

for (const request of [false, true]) {
  test(`${request ? "request-rendered" : "static"} API: operations are listed in their own version's tag index`, { timeout: 300_000 }, async () => {
    const site = await sites.buildSite(
      {
        "src/content.config.ts": `import { defineCollection } from "astro:content";
import { apiCollection } from ${srcModule("content.ts")};
export const collections = { api: defineCollection(apiCollection()) };`,
        "src/pages/[...slug].astro": `---
import { getApiRoute, getApiStaticPaths } from ${runtime};
${request ? "" : `export const getStaticPaths = getApiStaticPaths("api");`}
const result = await getApiRoute(Astro, "api");
if (result instanceof Response) return result;
---
<html><body>{result.page.kind}</body></html>
`,
        "src/pages/[...slug]/index.md.ts": `import { markdownRoute } from ${endpoints};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = markdownRoute();\n`,
        "src/pages/llms.txt.ts": `import { llmsRoute } from ${endpoints};\nexport const prerender = true;\nexport const { GET } = llmsRoute();\n`,
        "src/pages/llms-full.txt.ts": `import { llmsFullRoute } from ${endpoints};\nexport const prerender = true;\nexport const { GET } = llmsFullRoute();\n`,
        "src/pages/[...section]/llms.txt.ts": `import { llmsSectionRoute } from ${endpoints};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = llmsSectionRoute();\n`,
      },
      {
        packageImports: true,
        logLevel: "warn",
        server: request,
        adapterName: "@astrojs/cloudflare",
        ...(request ? { rendering: { default: "build", collections: { api: "request" } } } : {}),
        api: [
          {
            collection: "api",
            versions: [
              { version: "v2", spec: path.join(specDir, "v2.json"), default: true, routes: { convention: "resource-action-v2" } },
              { version: "v1", spec: path.join(specDir, "v1.json"), routes: { convention: "resource-action-v2" } },
            ],
          },
        ],
      },
    );
    const dist = path.join(site.root, "dist");
    // On server output the API's routes render on request, so its section
    // indexes are made from the page list when asked: the server answers.
    if (request) assetRoots.set("example.test", { dir: path.join(site.root, "dist"), base: "/docs" });
    const app = request ? await siteApp(site) : undefined;
    const fetchDoc = async (file: string): Promise<Response> =>
      app!.render(new Request(`https://example.test/docs/${file}`));
    // A route the policy builds ahead of time wrote its file; one it renders
    // on request answers from the server.
    const read = async (file: string): Promise<string> => {
      const full = path.join(dist, file);
      if (existsSync(full)) return readFile(full, "utf8");
      assert.ok(request, `${file} is built`);
      const response = await fetchDoc(file);
      assert.equal(response.status, 200, file);
      return response.text();
    };
    const missing = async (file: string): Promise<boolean> => {
      if (existsSync(path.join(dist, file))) return false;
      if (!request) return true;
      return (await fetchDoc(file)).status === 404;
    };

    const users = await read("tags/users/llms.txt");
    assert.match(users, /\[List users\]\(https:\/\/example\.test\/docs\/users\/list\/index\.md\)/);
    assert.match(users, /\[Create user\]\(https:\/\/example\.test\/docs\/users\/create\/index\.md\)/);
    assert.doesNotMatch(users, /List invoices/);
    // The operations' URL folder isn't a section of its own.
    assert.ok(await missing("users/llms.txt"), "no /users/llms.txt");

    const accounts = await read("v1/tags/accounts/llms.txt");
    assert.match(accounts, /\[List users\]\(https:\/\/example\.test\/docs\/v1\/users\/list\/index\.md\)/);
    assert.doesNotMatch(accounts, /\/users\/list\/index\.md\)[\s\S]*v2/);
    assert.ok(await missing("v1/tags/users/llms.txt"), "v1 has no Users tag");

    const fullDocument = await read("llms-full.txt");
    if (/served by section/.test(fullDocument)) {
      // On request the full document is an index of parts, one per section
      // and one more per other version; a version's part holds only its pages.
      const index = fullDocument;
      const parts = [...index.matchAll(/^- \[([^\]]*)\]\(https:\/\/example\.test\/docs\/([^)]*llms-full\.txt[^)]*)\)/gm)].map((m) => [m[1]!, m[2]!]);
      const versioned = parts.filter(([label]) => / \(v1\)$/.test(label));
      const current = parts.filter(([label]) => !/ \(v1\)$/.test(label));
      assert.ok(versioned.length > 0 && current.length > 0, index);
      for (const [, url] of versioned) {
        const sources = [...(await read(url)).matchAll(/^Source: (\S+)/gm)].map((m) => new URL(m[1]!).pathname);
        assert.ok(sources.length > 0 && sources.every((source) => source.startsWith("/docs/v1/")), `${url}: ${sources.join(", ")}`);
      }
      for (const [, url] of current) {
        const sources = [...(await read(url)).matchAll(/^Source: (\S+)/gm)].map((m) => new URL(m[1]!).pathname);
        assert.ok(sources.length > 0 && sources.every((source) => !source.startsWith("/docs/v1/")), `${url}: ${sources.join(", ")}`);
      }
      return;
    }
    // Each version reads as a block in llms-full.txt, its overview first.
    const fullText = fullDocument;
    const sources = [...fullText.matchAll(/^Source: (\S+)/gm)].map((match) => new URL(match[1]!).pathname);
    const v1 = sources.filter((source) => source.startsWith("/docs/v1/"));
    assert.ok(v1.length > 0, sources.join(", "));
    assert.equal(v1[0], "/docs/v1/", sources.join(", "));
    const first = sources.indexOf(v1[0]!);
    assert.deepEqual(sources.slice(first, first + v1.length), v1, sources.join(", "));
  });
}
