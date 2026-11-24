// `astro dev` follows content.config.ts when it adds `docs`: with no restart,
// its pages, Markdown, sidebar rows and llms.txt lines come in, while another
// collection's page keeps serving.

import assert from "node:assert/strict";
import { test } from "node:test";

import { until, withDevSite } from "./fixtures/dev-site.ts";

const config = (docs: boolean) => `import { defineCollection } from "astro:content";
import { docsCollection } from "@cloudflare/nimbus-docs/content";
export const collections = {
  guides: defineCollection(docsCollection({ base: "guides" })),
  ${docs ? "docs: defineCollection(docsCollection())," : ""}
};`;

// The starter's own routes: docs pages and their Markdown, llms.txt, and a
// second collection's page that shows the docs sidebar.
const DOCS_PAGE = `---
import { getDocsPage, getDocsStaticPaths } from "@cloudflare/nimbus-docs/runtime";
export const getStaticPaths = getDocsStaticPaths;
const page = await getDocsPage(Astro);
if (page instanceof Response) return page;
const { entry, Content } = page;
---
<html><body><h1>{entry.data.title}</h1><Content /></body></html>
`;

const HOST_PAGE = `---
import { getCollectionPage, getCollectionStaticPaths, getSidebar } from "@cloudflare/nimbus-docs/runtime";
export const getStaticPaths = getCollectionStaticPaths("guides");
const page = await getCollectionPage(Astro, "guides");
if (page instanceof Response) return page;
const labels = [];
const walk = (items) => {
  for (const item of items) {
    labels.push(item.label);
    if (item.type === "group") walk(item.children);
  }
};
walk(await getSidebar("/"));
---
<html><body><h1>{page.entry.data.title}</h1><main>labels:{labels.join(",")};</main></body></html>
`;

test("dev adds docs as content.config.ts declares it, with no restart", { timeout: 300_000 }, async () => {
  const files = {
    "src/content.config.ts": config(false),
    "src/content/guides/start.md": "---\ntitle: Start\n---\nStart.\n",
    "src/content/docs/intro.md": "---\ntitle: Intro\n---\nIntro body.\n",
    "src/pages/[...slug].astro": DOCS_PAGE,
    "src/pages/[...slug]/index.md.ts": `import { markdownRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\nexport const { GET, getStaticPaths } = markdownRoute();\n`,
    "src/pages/llms.txt.ts": `import { llmsRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\nexport const { GET } = llmsRoute();\n`,
    "src/pages/guides/[...slug].astro": HOST_PAGE,
  };
  await withDevSite(files, {}, async ({ write, page, serves, since, mark, restartsSince }) => {
    const begin = mark();
    const state = async () => {
      const host = await page("/guides/start/");
      const llms = await page("/llms.txt");
      // The pages that stay must serve throughout, so an error can't pass for "gone".
      assert.equal(host.status, 200, host.body.slice(0, 300));
      assert.equal(llms.status, 200, llms.body.slice(0, 300));
      return {
        sidebar: /labels:([^;]*);/.exec(host.body)?.[1]?.includes("Intro") ?? false,
        llms: llms.body.includes("/intro/"),
        page: (await page("/intro/")).status,
        markdown: (await page("/intro/index.md")).status,
      };
    };
    const absent = { sidebar: false, llms: false, page: 404, markdown: 404 };
    const present = { sidebar: true, llms: true, page: 200, markdown: 200 };
    const edit = async (docs: boolean) => {
      const start = mark();
      await write("src/content.config.ts", config(docs));
      await until("the content sync", () => since(start), (text) => /Content config changed[\s\S]*Synced content/.test(text));
    };
    const settlesTo = (label: string, want: typeof absent) =>
      until(label, state, (value) => JSON.stringify(value) === JSON.stringify(want));

    await serves("/guides/start/", "labels:");
    await settlesTo("docs absent at first", absent);

    await edit(true);
    await settlesTo("docs added", present);

    assert.equal(restartsSince(begin), 0, "no restart");
  });
});
