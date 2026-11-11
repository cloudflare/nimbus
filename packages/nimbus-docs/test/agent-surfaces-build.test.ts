// Deleting an agent route file drops its surface from the build: no files, no
// links, no alternate header, no negotiation. Nimbus respects the tree.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "astro";

import { discoveryFixture as fixture } from "./fixtures/agent-discovery-site.js";
import { srcModule, testAdapter } from "./fixtures/agent-site.js";
import { withPagefind } from "./fixtures/slice-site.ts";

type App = { render(request: Request): Promise<Response> };

async function manifest(root: string) {
  return JSON.parse(await readFile(path.join(root, "dist/_nimbus/agent-endpoint-assets/manifest.json"), "utf8")) as {
    markdownAssets: Array<{ url: string; surface: string; published?: false }>;
    llmsAssets: Array<{ scope: string; surface: string }>;
  };
}

test("a static site without the Markdown route builds no page Markdown and links the pages", async () => {
  const site = await fixture("---\ntitle: Root\n---\nRoot body.");
  try {
    await rm(path.join(site.root, "src/pages/[...slug]/index.md.ts"));
    await build(site.config);
    // A static build ships no manifest; the files are the evidence.
    assert.ok(!existsSync(path.join(site.root, "dist/guide/index.md")));
    assert.ok(!existsSync(path.join(site.root, "dist/index.md")));
    const llms = await site.read("dist/llms.txt");
    assert.match(llms, /\]\(https:\/\/example\.test\/docs\/guide\/\)/);
    assert.doesNotMatch(llms, /index\.md/);
    assert.doesNotMatch(await site.read("dist/.well-known/ard.json"), /text\/markdown/);
    assert.doesNotMatch(await site.read("dist/_headers"), /rel="alternate"/);
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("a request-rendered site without the Markdown route answers Accept: text/markdown with HTML", async () => {
  const site = await fixture("---\ntitle: Root\n---\nRoot body.", "docs", false, undefined, {
    rendering: { default: "request" },
  });
  try {
    await rm(path.join(site.root, "src/pages/[...slug]/index.md.ts"));
    await site.write(
      "src/pages/[...slug].astro",
      `---\nimport { getDocsPage } from ${srcModule("index.ts")};\nconst page = await getDocsPage(Astro);\nif (page instanceof Response) return page;\n---\n<html><body>Page</body></html>`,
    );
    await site.write(
      "server-entry.mjs",
      'import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n',
    );
    await build({
      ...site.config,
      output: "server",
      adapter: testAdapter(path.join(site.root, "server-entry.mjs")),
      build: { client: path.join(site.root, "dist"), server: path.join(site.root, ".server") },
    } as never);
    const { app } = (await import(pathToFileURL(path.join(site.root, ".server", "entry.mjs")).href)) as { app: App };
    const baked = await manifest(site.root);
    assert.deepEqual(baked.markdownAssets, []);
    const page = await app.render(
      new Request("https://example.test/docs/guide/", { headers: { Accept: "text/markdown" } }),
    );
    assert.equal(page.status, 200);
    assert.match(page.headers.get("Content-Type") ?? "", /text\/html/);
    const direct = await app.render(new Request("https://example.test/docs/guide/index.md"));
    assert.equal(direct.status, 404);
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("a request-rendered site with no search and no Markdown route builds a page that renders a partial", async () => {
  // No route, no MCP and no Pagefind: the build bakes no body for the page,
  // and the request-route inventory must not render one either (a partial
  // expands in the bake, not in the runtime renderer).
  const site = await fixture("---\ntitle: Root\n---\nRoot body.", "docs", false, undefined, {
    rendering: { default: "request" },
  });
  try {
    await rm(path.join(site.root, "src/pages/[...slug]/index.md.ts"));
    const content = pathToFileURL(path.resolve(import.meta.dirname, "../src/content.ts")).href;
    await site.write(
      "src/content.config.ts",
      `import { defineCollection } from "astro:content"; import { docsCollection, partialsCollection } from ${JSON.stringify(content)};\nexport const collections = { docs: defineCollection(docsCollection({ base: "docs" })), partials: defineCollection(partialsCollection()) };`,
    );
    await site.write("src/content/partials/snippet.mdx", "Snippet text.");
    await site.write("src/content/docs/guide.mdx", '---\ntitle: Guide\n---\n## Start\n\n<Render file="snippet" />\n');
    await site.write(
      "src/pages/[...slug].astro",
      `---\nimport { getDocsPage } from ${srcModule("index.ts")};\nconst page = await getDocsPage(Astro);\nif (page instanceof Response) return page;\n---\n<html><body>Page</body></html>`,
    );
    await site.write(
      "server-entry.mjs",
      'import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n',
    );
    await build({
      ...site.config,
      output: "server",
      adapter: testAdapter(path.join(site.root, "server-entry.mjs")),
      build: { client: path.join(site.root, "dist"), server: path.join(site.root, ".server") },
    } as never);
    const baked = await manifest(site.root);
    assert.deepEqual(baked.markdownAssets, []);
    const { app } = (await import(pathToFileURL(path.join(site.root, ".server", "entry.mjs")).href)) as { app: App };
    const page = await app.render(new Request("https://example.test/docs/guide/"));
    assert.equal(page.status, 200);
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("with every starter route the build is unchanged: twins, source, indexes, full document", async () => {
  const site = await fixture("---\ntitle: Root\n---\nRoot body.");
  try {
    // The fixture writes the Markdown and site index routes; the other three.
    const endpoints = srcModule("agent-endpoints.ts");
    await site.write(
      "src/pages/[...slug]/index.mdx.ts",
      `import { markdownSourceRoute } from ${endpoints};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = markdownSourceRoute();\n`,
    );
    await site.write(
      "src/pages/[...section]/llms.txt.ts",
      `import { llmsSectionRoute } from ${endpoints};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = llmsSectionRoute();\n`,
    );
    await site.write(
      "src/pages/llms-full.txt.ts",
      `import { llmsFullRoute } from ${endpoints};\nexport const prerender = true;\nexport const { GET } = llmsFullRoute();\n`,
    );
    await build(site.config);
    assert.ok(existsSync(path.join(site.root, "dist/guide/index.md")));
    assert.ok(existsSync(path.join(site.root, "dist/guide/index.mdx")));
    assert.ok(existsSync(path.join(site.root, "dist/llms-full.txt")));
    assert.match(await site.read("dist/guide/index.md"), /Source: https:\/\/example\.test\/docs\/guide\/index\.mdx/);
    assert.ok(existsSync(path.join(site.root, "dist/index.md")));
    assert.match(await site.read("dist/llms.txt"), /guide\/index\.md/);
    assert.match(await site.read("dist/.well-known/ard.json"), /text\/markdown/);
    assert.match(await site.read("dist/_headers"), /rel="alternate"/);
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("with Pagefind on, a request-rendered page's text is in the build cache, partial expanded, and not deployed", async (t) => {
  const site = await fixture("---\ntitle: Root\n---\nRoot body.", "docs", false, undefined, {
    rendering: { default: "request" },
    search: undefined,
  });
  try {
    await rm(path.join(site.root, "src/pages/[...slug]/index.md.ts"));
    const content = pathToFileURL(path.resolve(import.meta.dirname, "../src/content.ts")).href;
    await site.write(
      "src/content.config.ts",
      `import { defineCollection } from "astro:content"; import { docsCollection, partialsCollection } from ${JSON.stringify(content)};\nexport const collections = { docs: defineCollection(docsCollection({ base: "docs" })), partials: defineCollection(partialsCollection()) };`,
    );
    await site.write("src/content/partials/snippet.mdx", "Snippet text.");
    await site.write("src/content/docs/guide.mdx", '---\ntitle: Guide\n---\n## Start\n\n<Render file="snippet" />\n');
    await site.write(
      "src/pages/[...slug].astro",
      `---\nimport { getDocsPage } from ${srcModule("index.ts")};\nconst page = await getDocsPage(Astro);\nif (page instanceof Response) return page;\n---\n<html><body>Page</body></html>`,
    );
    await site.write(
      "server-entry.mjs",
      'import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n',
    );
    const built = await withPagefind(() =>
      build({
        ...site.config,
        output: "server",
        adapter: testAdapter(path.join(site.root, "server-entry.mjs")),
        build: { client: path.join(site.root, "dist"), server: path.join(site.root, ".server") },
      } as never).then(() => true),
    );
    if (!built) return t.skip("pagefind is not installed in the workspace");
    const holding = async (dir: string) => {
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(dir, { recursive: true, withFileTypes: true });
      const bodies = await Promise.all(
        files.filter((file) => file.isFile()).map((file) => readFile(path.join(file.parentPath, file.name), "utf8").catch(() => "")),
      );
      return bodies.filter((body) => body.includes("Snippet text")).length;
    };
    // The page's text, partial expanded, is in the build cache for Pagefind
    // and in no deployed file: no route publishes it.
    assert.ok((await holding(path.join(site.root, ".astro/nimbus/agent-endpoint-assets"))) > 0);
    assert.equal(await holding(path.join(site.root, "dist")), 0);
    assert.ok(existsSync(path.join(site.root, "dist/pagefind/pagefind.js")));
    assert.deepEqual((await manifest(site.root)).markdownAssets, []);
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});
