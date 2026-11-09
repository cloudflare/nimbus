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

test("with every starter route the build is unchanged: twins, source, indexes, full document", async () => {
  const site = await fixture("---\ntitle: Root\n---\nRoot body.");
  try {
    await build(site.config);
    assert.ok(existsSync(path.join(site.root, "dist/guide/index.md")));
    assert.ok(existsSync(path.join(site.root, "dist/index.md")));
    assert.match(await site.read("dist/llms.txt"), /guide\/index\.md/);
    assert.match(await site.read("dist/.well-known/ard.json"), /text\/markdown/);
    assert.match(await site.read("dist/_headers"), /rel="alternate"/);
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});
