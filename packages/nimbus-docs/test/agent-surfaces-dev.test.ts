// `astro dev` follows the agent route files as they change: deleting the
// Markdown route drops a page's `.md`, its alternate link and the index's
// Markdown links; adding it back brings them back. Deleting the llms route
// drops the index and the "Documentation Index" note from page Markdown.

import assert from "node:assert/strict";
import { rename } from "node:fs/promises";
import { test } from "node:test";

import { moduleUrl, until, withDevSite } from "./fixtures/dev-site.ts";

const PAGE = `---
import { getDocsStaticPaths, getDocsPage } from ${moduleUrl("runtime.ts")};
import NimbusHead from ${moduleUrl("components/NimbusHead.astro")};
export const getStaticPaths = getDocsStaticPaths;
const page = await getDocsPage(Astro);
if (page instanceof Response) return page;
---
<html><head><NimbusHead title={page.entry.data.title} collection="docs" markdownUrl={page.markdownUrl} /></head><body>doc:{page.entry.data.title}</body></html>
`;

test("dev follows the agent route files: deleting and restoring the Markdown and llms routes", { timeout: 240_000 }, async () => {
  const files = {
    "src/content.config.ts": `import { defineCollection } from "astro:content";
import { docsCollection } from ${moduleUrl("content.ts")};
export const collections = { docs: defineCollection(docsCollection()) };`,
    "src/content/docs/index.md": "---\ntitle: Home\n---\n\nWelcome.\n",
    "src/content/docs/guide.md": "---\ntitle: Guide\n---\n\nRead me.\n",
    "src/pages/[...slug].astro": PAGE,
    "src/pages/[...slug]/index.md.ts": `import { markdownRoute } from ${moduleUrl("agent-endpoints.ts")};
export const prerender = true;
export const { GET, getStaticPaths } = markdownRoute();
`,
    "src/pages/llms.txt.ts": `import { llmsRoute } from ${moduleUrl("agent-endpoints.ts")};
export const prerender = true;
export const { GET } = llmsRoute();
`,
  };
  await withDevSite(files, {}, async ({ file, page, serves }) => {
    await serves("/guide/", "doc:Guide");
    await serves("/guide/index.md", "# Guide");
    assert.match((await page("/guide/index.md")).body, /> Documentation Index/);
    assert.match((await page("/llms.txt")).body, /\[Guide\]\([^)]*\/guide\/index\.md\)/);
    assert.match((await page("/guide/")).body, /rel="alternate" type="text\/markdown"/);

    // Delete the Markdown route: no .md, no alternate link, the index links the page.
    await rename(file("src/pages/[...slug]/index.md.ts"), file("index.md.ts.off"));
    await until("the Markdown route to be gone", () => page("/guide/index.md"), ({ status }) => status === 404);
    await until(
      "llms.txt to link the page URL",
      () => page("/llms.txt"),
      ({ body }) => /\[Guide\]\([^)]*\/guide\/\)/.test(body) && !body.includes("/guide/index.md"),
    );
    await until(
      "the page to drop its alternate link",
      () => page("/guide/"),
      ({ status, body }) => status === 200 && !/rel="alternate" type="text\/markdown"/.test(body),
    );

    // Restore it: everything comes back.
    await rename(file("index.md.ts.off"), file("src/pages/[...slug]/index.md.ts"));
    await serves("/guide/index.md", "# Guide");
    await until("llms.txt to link the Markdown again", () => page("/llms.txt"), ({ body }) => body.includes("/guide/index.md"));
    await until("the alternate link to return", () => page("/guide/"), ({ body }) => /rel="alternate" type="text\/markdown"/.test(body));

    // Delete the llms route: no index, no note in the page's Markdown.
    await rename(file("src/pages/llms.txt.ts"), file("llms.txt.ts.off"));
    await until("llms.txt to be gone", () => page("/llms.txt"), ({ status }) => status === 404);
    await until(
      "the Markdown to drop the index note",
      () => page("/guide/index.md"),
      ({ status, body }) => status === 200 && !body.includes("Documentation Index"),
    );
    await rename(file("llms.txt.ts.off"), file("src/pages/llms.txt.ts"));
    await serves("/llms.txt", "[Guide]");
    await until("the note to return", () => page("/guide/index.md"), ({ body }) => body.includes("Documentation Index"));
  });
});
