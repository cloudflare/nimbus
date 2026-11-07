// With nested `llms.txt` sections, an API operation is listed in its tag's
// index, as the sidebar groups it, even when its URL isn't under the tag
// (`resource-action-v2` serves `/users/list` and the tag at `/tags/users`).
// Each version follows its own nav: the same operation is under a different
// tag in v1. A static build reads the nav from the API model; a request-
// rendered API from its prepared pages.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

import { readLlmsEndpointPayload } from "../src/_internal/agent-endpoint-assets.js";
import { agentSites, srcModule } from "./fixtures/agent-site.ts";
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
    // On server output the section indexes are served on request from the
    // assets the build baked; this harness has no Cloudflare runtime to serve
    // them, so it reads the baked index as the route would.
    const read = async (file: string): Promise<string> => {
      if (request) {
        const section = file.replace(/\/llms\.txt$/, "");
        return (await readLlmsEndpointPayload(site.root, { scope: "section", surface: "index", section })).body;
      }
      const full = path.join(dist, file);
      assert.ok(existsSync(full), `${file} is built`);
      return readFile(full, "utf8");
    };
    const missing = async (file: string): Promise<boolean> => {
      if (!request) return !existsSync(path.join(dist, file));
      const section = file.replace(/\/llms\.txt$/, "");
      return readLlmsEndpointPayload(site.root, { scope: "section", surface: "index", section }).then(
        () => false,
        () => true,
      );
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
  });
}
