// `astro dev` renders a page's headings when the page is first requested, and
// again after its source changes. Its own file, because a dev server and a
// build in one process share module state.

import assert from "node:assert/strict";
import { test } from "node:test";
import { dev } from "astro";
import { JSDOM } from "jsdom";

import { paritySite, src } from "./fixtures/parity-site.ts";

test("dev resolves page headings per request and follows edits", async () => {
  const site = await paritySite({
    routes: {
      "src/pages/[...slug].astro": [
        "---",
        `import { getDocsStaticPaths, getDocsPageProps } from ${src("runtime.ts")};`,
        "export const prerender = true;",
        "export const getStaticPaths = getDocsStaticPaths;",
        "const { headings } = await getDocsPageProps(Astro);",
        "---",
        "<html><body><pre>{JSON.stringify(headings.map((heading) => heading.slug))}</pre></body></html>",
      ].join("\n"),
    },
  });
  try {
    await site.write("src/content/docs/index.md", "---\ntitle: Home\n---\n\n## First\n\n### Nested\n");
    const server = await dev({ ...site.config, server: { port: 0, host: "127.0.0.1" } });
    try {
      const get = async () => {
        const response = await fetch(`http://127.0.0.1:${server.address.port}/`);
        assert.equal(response.status, 200);
        return new JSDOM(await response.text()).window.document.querySelector("pre")?.textContent;
      };
      assert.equal(await get(), '["first","nested"]');
      await site.write("src/content/docs/index.md", "---\ntitle: Home\n---\n\n## Renamed\n");
      let seen: string | null | undefined;
      for (let attempt = 0; attempt < 40 && seen !== '["renamed"]'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        seen = await get();
      }
      assert.equal(seen, '["renamed"]');
    } finally {
      await server.stop();
    }
  } finally {
    await site.remove();
  }
});
