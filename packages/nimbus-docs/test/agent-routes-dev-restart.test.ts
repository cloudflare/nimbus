// `astro dev` follows the agent route files the way it follows a collection's
// route: only setup declares the routes a mounted collection gets from them,
// so removing or adding one restarts the server; an edit to one doesn't.

import assert from "node:assert/strict";
import { appendFile, rm } from "node:fs/promises";
import { test } from "node:test";

import { moduleUrl, settle, until, withDevSite } from "./fixtures/dev-site.ts";

const SDK_ROUTE = `---
import { getCollectionPage, getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";
export const getStaticPaths = getCollectionStaticPaths("sdk");
const page = await getCollectionPage(Astro);
if (page instanceof Response) return page;
---
<html><body><main>sdk:{page.entry.id}</main></body></html>
`;

const MARKDOWN_ROUTE = `import { markdownRoute } from ${moduleUrl("agent-endpoints.ts")};
export const prerender = false;
export const { GET, getStaticPaths } = markdownRoute();
`;

test("dev restarts when an agent route file is removed or added, and not when edited", { timeout: 240_000 }, async () => {
  const files = {
    "src/content.config.ts": `import { defineCollection } from "astro:content";
import { docsCollection } from ${moduleUrl("content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  sdk: defineCollection(docsCollection({ base: "sdk" })),
};`,
    "src/content/docs/index.mdx": "---\ntitle: Home\n---\nHome.\n",
    "src/content/sdk/setup.mdx": "---\ntitle: Setup\n---\nSet it up.\n",
    "src/pages/sdk/[...slug].astro": SDK_ROUTE,
    "src/pages/[...slug]/index.md.ts": MARKDOWN_ROUTE,
  };
  await withDevSite(files, { rendering: { default: "request", collections: { sdk: "request" } } }, async ({ file, write, page, serves, since, restartsSince, restarted, mark: now }) => {
    // The mounted collection's Markdown comes from the route setup injected
    // for it, which reuses the root route file.
    await serves("/sdk/setup/index.md", "Set it up");

    let mark = now();
    await rm(file("src/pages/[...slug]/index.md.ts"));
    await restarted(mark);
    await until("the mounted Markdown to be gone", () => page("/sdk/setup/index.md"), ({ status }) => status === 404);
    assert.ok(restartsSince(mark) >= 1 && restartsSince(mark) <= 2, since(mark));

    mark = now();
    await write("src/pages/[...slug]/index.md.ts", MARKDOWN_ROUTE);
    await restarted(mark);
    await serves("/sdk/setup/index.md", "Set it up");
    assert.ok(restartsSince(mark) >= 1 && restartsSince(mark) <= 2, since(mark));

    mark = now();
    await appendFile(file("src/pages/[...slug]/index.md.ts"), "// edited\n");
    await settle(1500);
    assert.equal(restartsSince(mark), 0, since(mark));
    await serves("/sdk/setup/index.md", "Set it up");
  });
});
