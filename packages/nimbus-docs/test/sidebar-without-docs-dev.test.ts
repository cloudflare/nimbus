// `astro dev` follows content.config.ts: adding a `docs` collection puts its
// pages in the sidebar without a restart, and removing it takes them out.
// A site whose content.config.ts declares no `docs` doesn't query it, in dev
// as in a build.

import assert from "node:assert/strict";
import { test } from "node:test";

import { until, withDevSite } from "./fixtures/dev-site.ts";

const config = (collections: string) => `import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";
const collection = (base: string) => defineCollection({ loader: glob({ pattern: "**/*.md", base }), schema: z.object({ title: z.string() }) });
export const collections = { ${collections} };`;

const PAGE = `---
import { getSidebar } from "@cloudflare/nimbus-docs/runtime";
const labels = [];
const walk = (items) => {
  for (const item of items) {
    labels.push(item.label);
    if (item.type === "group") walk(item.children);
  }
};
walk(await getSidebar("/"));
---
<html><body><main>labels:{labels.join(",")};</main></body></html>
`;

test("dev adds and removes docs pages in the sidebar as content.config.ts declares docs", { timeout: 240_000 }, async () => {
  const files = {
    "src/content.config.ts": config(`guides: collection("./src/content/guides")`),
    "src/content/guides/start.md": "---\ntitle: Start\n---\nStart.\n",
    "src/content/docs/intro.md": "---\ntitle: Intro\n---\nIntro.\n",
    "src/pages/index.astro": PAGE,
  };
  await withDevSite(files, {}, async ({ write, page, serves, since, mark }) => {
    // A broken page must not pass for "Intro is gone".
    const labels = async () => {
      const { status, body } = await page("/");
      assert.equal(status, 200, body.slice(0, 300));
      return /labels:([^;]*);/.exec(body)?.[1]?.split(",") ?? [];
    };
    // A request during the content sync caches the old sidebar; edit, then
    // ask once the sync is done.
    const edit = async (collections: string) => {
      const start = mark();
      await write("src/content.config.ts", config(collections));
      await until("the content sync", () => since(start), (text) => /Content config changed[\s\S]*Synced content/.test(text));
    };
    await serves("/", "labels:");
    assert.ok(!(await labels()).includes("Intro"));

    await edit(`guides: collection("./src/content/guides"), docs: collection("./src/content/docs")`);
    await until("Intro in the sidebar", labels, (value) => value.includes("Intro"));

    await edit(`guides: collection("./src/content/guides")`);
    await until("Intro out of the sidebar", labels, (value) => !value.includes("Intro"));
  });
});

test("dev doesn't query docs on a site without it", { timeout: 240_000 }, async () => {
  const files = {
    "src/content.config.ts": config(`guides: collection("./src/content/guides")`),
    "src/content/guides/start.md": "---\ntitle: Start\n---\nStart.\n",
    "src/pages/index.astro": PAGE,
  };
  await withDevSite(files, {}, async ({ serves, since }) => {
    await serves("/", "labels:");
    assert.doesNotMatch(since(0), /The collection "docs" does not exist/);
  });
});
