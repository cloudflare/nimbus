// `astro dev` follows an API collection's route file to the site root: moving
// it restarts the server onto root URLs, with no error for serving an API
// there.

import assert from "node:assert/strict";
import { rename } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { moduleUrl, withDevSite } from "./fixtures/dev-site.ts";

const API_ROUTE = `---
import { getApiRoute, getApiStaticPaths } from "@cloudflare/nimbus-docs/runtime";
export const getStaticPaths = getApiStaticPaths("api");
const result = await getApiRoute(Astro, "api");
if (result instanceof Response) return result;
---
<html><body><main>api:{result.page.kind} <a class="self" href={result.page.href}>self</a></main></body></html>
`;

test("dev restarts onto root URLs when an API's route moves to the site root", { timeout: 240_000 }, async () => {
  const files = {
    "src/content.config.ts": `import { defineCollection } from "astro:content";
import { apiCollection } from ${moduleUrl("content.ts")};
export const collections = { api: defineCollection(apiCollection()) };`,
    "spec.json": JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Pets", version: "1" },
      paths: { "/pets": { get: { operationId: "listPets", summary: "List pets", tags: ["Pets"], responses: { "200": { description: "ok" } } } } },
    }),
    "src/pages/api/[...slug].astro": API_ROUTE,
  };
  await withDevSite(files, { api: [{ collection: "api", spec: "./spec.json" }] }, async ({ file, page, serves, since, restarted, mark: now }) => {
    await serves("/api/Pets/listPets/", "api:operation");

    const mark = now();
    await rename(file("src/pages/api/[...slug].astro"), file("src/pages/[...slug].astro"));
    await serves("/Pets/listPets/", "api:operation");
    await restarted(mark);
    assert.doesNotMatch(since(mark), /collection-api-root/);
    assert.equal((await page("/api/Pets/listPets/")).status, 404);
    const home = await page("/");
    assert.match(home.body, /api:api /);
    const document = new JSDOM(home.body).window.document;
    assert.equal(document.querySelector("a.self")?.getAttribute("href"), "/");
  });
});
