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

test("a route that re-exports the Markdown factory from the site's own module still gets the homepage fallback", async () => {
  // No root entry: the llms index stands in for /index.md, as it does when
  // the route file calls the factory itself.
  const site = await fixture(undefined);
  try {
    await site.write(
      "src/lib/markdown.ts",
      `import { markdownRoute } from ${srcModule("agent-endpoints.ts")};\nexport const { GET, getStaticPaths } = markdownRoute();\n`,
    );
    await site.write("src/pages/[...slug]/index.md.ts", 'export const prerender = true;\nexport { GET, getStaticPaths } from "../../lib/markdown.ts";\n');
    await build(site.config);
    assert.ok(existsSync(path.join(site.root, "dist/guide/index.md")));
    assert.equal(await site.read("dist/index.md"), await site.read("dist/llms.txt"));
    assert.match(await site.read("dist/.well-known/ard.json"), /text\/markdown/);
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("the full document is baked for a route that serves it at the site's own path", async () => {
  // No `/llms-full.txt` route, so the indexes name no full document; the
  // site's `all.md` route reads the same payload and serves it there.
  const site = await fixture("---\ntitle: Root\n---\nRoot body.");
  try {
    await site.write(
      "src/pages/all.md.ts",
      `import { llmsFullRoute } from ${srcModule("agent-endpoints.ts")};\nexport const prerender = true;\nexport const { GET } = llmsFullRoute();\n`,
    );
    await build(site.config);
    assert.ok(!existsSync(path.join(site.root, "dist/llms-full.txt")));
    assert.match(await site.read("dist/all.md"), /Hello discovery/);
    assert.doesNotMatch(await site.read("dist/llms.txt"), /Full documentation/);
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

// A route file that calls a factory from a shape Nimbus doesn't record
// publishes nothing; the build says so, and names a recorded route it may
// answer ahead of.
const OLD_SHAPE = `import { markdownRoute } from ${srcModule("agent-endpoints.ts")};\nexport const prerender = false;\nexport const { GET } = markdownRoute();\n`;
const REQUEST_PAGE = `---\nimport { getDocsPage } from ${srcModule("index.ts")};\nconst page = await getDocsPage(Astro);\nif (page instanceof Response) return page;\n---\n<html><body>Page</body></html>`;

async function buildWithLogs(site: Awaited<ReturnType<typeof fixture>>, config: Record<string, unknown> = {}) {
  const output: string[] = [];
  const restore = [process.stdout, process.stderr].map((stream) => {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: string | Uint8Array) => (output.push(String(chunk)), true)) as typeof stream.write;
    return () => (stream.write = original);
  });
  try {
    await build({
      ...site.config,
      output: "server",
      adapter: testAdapter(path.join(site.root, "server-entry.mjs")),
      build: { client: path.join(site.root, "dist"), server: path.join(site.root, ".server") },
      logLevel: "warn",
      ...config,
    } as never);
  } finally {
    for (const back of restore) back();
  }
  return output.join("").replace(/\x1b\[[0-9;]*m/g, "");
}

async function requestSite(files: Record<string, string>, keepStarter: boolean) {
  const site = await fixture("---\ntitle: Root\n---\nRoot body.", "docs", false, undefined, { rendering: { default: "request" } });
  if (!keepStarter) await rm(path.join(site.root, "src/pages/[...slug]/index.md.ts"));
  await site.write("src/pages/[...slug].astro", REQUEST_PAGE);
  await site.write("server-entry.mjs", 'import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n');
  for (const [file, body] of Object.entries(files)) await site.write(file, body);
  return site;
}

test("a factory called from [...slug].md.ts is named as publishing nothing, and the request still 404s", async () => {
  const site = await requestSite({ "src/pages/[...slug].md.ts": OLD_SHAPE }, false);
  try {
    const logs = await buildWithLogs(site);
    assert.match(logs, /src\/pages\/\[\.\.\.slug\]\.md\.ts calls markdownRoute\(\), but Nimbus records an agent route only where the last segment is a static file name, so this file publishes nothing: no page's Markdown URL, link or alternate comes from it\. Move the call to src\/pages\/\[\.\.\.slug\]\/index\.md\.ts\./);
    assert.doesNotMatch(logs, /Astro may send/);
    const { app } = (await import(pathToFileURL(path.join(site.root, ".server", "entry.mjs")).href)) as { app: App };
    assert.equal((await app.render(new Request("https://example.test/docs/guide/index.md"))).status, 404);
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("beside the starter's route the old shape is named as answering ahead of it", async () => {
  const site = await requestSite({ "src/pages/[...slug].md.ts": OLD_SHAPE }, true);
  try {
    const logs = await buildWithLogs(site);
    assert.match(logs, /Astro may send requests to this file ahead of src\/pages\/\[\.\.\.slug\]\/index\.md\.ts, so delete it, or keep it for redirects/);
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("a prefixed old shape names the root starter it may shadow, and not a disjoint route", async () => {
  const shadowing = await requestSite({ "src/pages/blog/[...slug].md.ts": OLD_SHAPE }, true);
  try {
    const logs = await buildWithLogs(shadowing);
    assert.match(logs, /src\/pages\/blog\/\[\.\.\.slug\]\.md\.ts calls markdownRoute\(\)/);
    assert.match(logs, /Move the call to src\/pages\/blog\/\[\.\.\.slug\]\/index\.md\.ts\. Astro may send requests to this file ahead of src\/pages\/\[\.\.\.slug\]\/index\.md\.ts/);
  } finally {
    await rm(shadowing.root, { recursive: true, force: true });
  }
  const disjoint = await requestSite({ "src/pages/blog/[...slug].md.ts": OLD_SHAPE, "src/pages/docs/[...slug]/index.md.ts": `export const prerender = false;\nexport const GET = () => new Response("own", { headers: { "Content-Type": "text/markdown" } });\n` }, false);
  try {
    const logs = await buildWithLogs(disjoint);
    assert.match(logs, /src\/pages\/blog\/\[\.\.\.slug\]\.md\.ts calls markdownRoute\(\)/);
    assert.doesNotMatch(logs, /Astro may send/);
  } finally {
    await rm(disjoint.root, { recursive: true, force: true });
  }
});

test("a redirects-only file at the old shape gets no warning, and a prerendered factory call still fails the build after it", async () => {
  const quiet = await requestSite({ "src/pages/[...slug].md.ts": "export const prerender = false;\nexport const GET = (context) => context.redirect(`${context.url.pathname.replace(/\\.md$/, '')}/index.md`, 301);\n" }, true);
  try {
    const logs = await buildWithLogs(quiet);
    assert.doesNotMatch(logs, /calls markdownRoute\(\)/);
  } finally {
    await rm(quiet.root, { recursive: true, force: true });
  }
  const prerendered = await fixture("---\ntitle: Root\n---\nRoot body.");
  try {
    await rm(path.join(prerendered.root, "src/pages/[...slug]/index.md.ts"));
    await prerendered.write("src/pages/[...slug].md.ts", OLD_SHAPE.replace("prerender = false", "prerender = true").replace("{ GET }", "{ GET, getStaticPaths }"));
    const output: string[] = [];
    const restore = [process.stdout, process.stderr].map((stream) => {
      const original = stream.write.bind(stream);
      stream.write = ((chunk: string | Uint8Array) => (output.push(String(chunk)), true)) as typeof stream.write;
      return () => (stream.write = original);
    });
    let failure: unknown;
    try {
      await build({ ...prerendered.config, logLevel: "warn" } as never);
    } catch (error) {
      failure = error;
    } finally {
      for (const back of restore) back();
    }
    assert.match(output.join(""), /calls markdownRoute\(\), but Nimbus records an agent route only/);
    assert.match(String(failure), /not an endpoint whose last segment is a static \.md or \.mdx file name/);
  } finally {
    await rm(prerendered.root, { recursive: true, force: true });
  }
});

test("the surfaces line counts a request-rendered API page once", async () => {
  const site = await fixture("---\ntitle: Root\n---\nRoot body.", "docs", true, undefined, { rendering: { default: "request" } });
  try {
    await site.write("src/pages/[...slug].astro", REQUEST_PAGE);
    await site.write("server-entry.mjs", 'import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n');
    const logs = await buildWithLogs(site, { logLevel: "info", adapter: testAdapter(path.join(site.root, "server-entry.mjs"), "@astrojs/cloudflare") });
    const line = logs.match(/Page Markdown: served for (\d+) of (\d+) pages/);
    assert.ok(line, logs.split("\n").filter((entry) => entry.includes("Agent surfaces")).join("\n"));
    const baked = await manifest(site.root);
    const api = JSON.parse(await readFile(path.join(site.root, "dist/_nimbus/agent-endpoint-assets/manifest.json"), "utf8")) as { renderedPages?: unknown[] };
    // Every page with a Markdown URL: the docs twins baked, plus the API pages made on request, each once.
    const expected = baked.markdownAssets.filter((asset) => asset.surface === "markdown" && asset.published !== false).length + (api.renderedPages?.length ?? 0);
    assert.equal(Number(line![1]), expected);
    assert.equal(line![1], line![2]);
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});
