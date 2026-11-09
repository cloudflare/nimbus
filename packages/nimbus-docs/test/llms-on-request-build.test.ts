// The agent documents on request: on a site whose routes all render on
// request, `/llms.txt`, each section index, `/llms-full.txt` and its parts are
// not baked; the Worker makes them from the manifest's page list through the
// functions the bake uses, so the indexes match a build-rendered site's files
// in membership, order, titles, descriptions and links, and a part's blocks
// are the build-rendered full document's. Server builds for the Cloudflare
// adapter (by name; the Workers assets binding is stubbed to read dist/).

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";

import { build, type AstroIntegration } from "astro";

import nimbus from "../src/index.ts";
import { runningNimbusVersion } from "../src/_internal/upgrades.ts";
import { TEST_TMP } from "./fixtures/temp-root.js";

register(new URL("./fixtures/mcp/workers-loader.mjs", import.meta.url));
const assetRoots = ((globalThis as { __nimbusTestAssetRoots?: Map<string, { dir: string; base: string }> }).__nimbusTestAssetRoots ??= new Map());

const SRC_DIR = path.resolve(import.meta.dirname, "../src");

const SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Pets", version: "1.0.0", description: "A pet store." },
  paths: {
    "/pets": {
      get: { operationId: "listPets", summary: "List pets", description: "Every pet.", responses: { "200": { description: "ok" } } },
      post: { operationId: "createPet", summary: "Create pet", responses: { "201": { description: "created" } } },
    },
  },
});

/** A query-versioned API: v2 default, v1 historical, with distinct summaries. */
const QV_SPEC = (version: string) =>
  JSON.stringify({
    openapi: "3.0.0",
    info: { title: `Weather ${version}`, version: "1.0.0", description: `Forecasts (${version}).` },
    paths: {
      "/forecast": {
        get: { operationId: "getForecast", summary: `Get a forecast (${version})`, responses: { "200": { description: "ok" } } },
      },
      ...(version === "v1"
        ? { "/legacy": { get: { operationId: "legacyReport", summary: "Legacy report (v1)", responses: { "200": { description: "ok" } } } } }
        : {}),
    },
  });

const DOCS: Record<string, string> = {
  "index.md": "---\ntitle: Home\ndescription: Start here.\n---\n\nWelcome.\n",
  "guide/index.md": "---\ntitle: Guide\ndescription: The guide.\n---\n\nRead [the start](/) first.\n",
  "guide/advanced.md": "---\ntitle: Advanced\n---\n\nDeeper.\n",
  "concepts/errors.md": "---\ntitle: Errors\ndescription: What can go wrong.\n---\n\nErrors happen.\n",
  "concepts/limits.md": "---\ntitle: Limits\n---\n\nSlow down.\n",
};

interface Site {
  root: string;
  app: { render(request: Request): Promise<Response> };
}

async function buildSite(host: string, rendering: "build" | "request", options: { markdownRoute?: boolean } = {}): Promise<Site> {
  const root = await realpath(await mkdtemp(path.join(TEST_TMP, "nimbus-llms-on-request-")));
  const write = async (relative: string, contents: string) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents, "utf8");
  };
  await symlink(path.resolve(import.meta.dirname, "../node_modules"), path.join(root, "node_modules"), "dir");
  await write("package.json", '{"type":"module"}\n');
  await write("nimbus.json", `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`);
  await write("specs/pets.json", SPEC);
  await write("specs/qv-v2.json", QV_SPEC("v2"));
  await write("specs/qv-v1.json", QV_SPEC("v1"));
  await write("specs/qv-v0.json", QV_SPEC("v0"));
  await write("specs/pv-v2.json", QV_SPEC("v2").replace("Weather", "Radar"));
  await write("specs/pv-v1.json", QV_SPEC("v1").replace("Weather", "Radar"));
  await write(
    "src/content.config.ts",
    `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection } from ${JSON.stringify(pathToFileURL(path.join(SRC_DIR, "content.ts")).href)};
export const collections = {
  docs: defineCollection(docsCollection()),
  pets: defineCollection(apiCollection()),
  qv: defineCollection(apiCollection()),
  pv: defineCollection(apiCollection()),
};
`,
  );
  for (const [file, body] of Object.entries(DOCS)) await write(`src/content/docs/${file}`, body);
  await write(
    "src/pages/[...slug].astro",
    `---
import { getDocsStaticPaths, getDocsPage } from "@cloudflare/nimbus-docs/runtime";
export const prerender = true;
export const getStaticPaths = getDocsStaticPaths;
const page = await getDocsPage(Astro);
if (page instanceof Response) return page;
---
<html><body>doc</body></html>
`,
  );
  for (const collection of ["pets", "qv", "pv"]) {
    await write(
      `src/pages/${collection}/[...slug].astro`,
      `---
import { getApiRoute, getApiStaticPaths } from "@cloudflare/nimbus-docs/runtime";
export const prerender = true;
export const getStaticPaths = getApiStaticPaths("${collection}");
const result = await getApiRoute(Astro);
if (result instanceof Response) return result;
const { page } = result;
---
<html><body><main data-title={page.title}>{page.title}</main></body></html>
`,
    );
  }
  const routes = {
    ...(options.markdownRoute === false ? {} : { "src/pages/[...slug]/index.md.ts": "markdownRoute" }),
    "src/pages/llms.txt.ts": "llmsRoute",
    "src/pages/[...section]/llms.txt.ts": "llmsSectionRoute",
    "src/pages/llms-full.txt.ts": "llmsFullRoute",
  };
  for (const [file, factory] of Object.entries(routes)) {
    const paths = factory === "llmsRoute" || factory === "llmsFullRoute" ? "GET" : "GET, getStaticPaths";
    await write(file, `import { ${factory} } from "@cloudflare/nimbus-docs/agent-endpoints";\nexport const { ${paths} } = ${factory}();\n`);
  }
  await write("server-entry.mjs", 'import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n');

  const adapter: AstroIntegration = {
    name: "@astrojs/cloudflare",
    hooks: {
      "astro:config:done": ({ setAdapter }) => {
        setAdapter({
          name: "@astrojs/cloudflare",
          entrypointResolution: "auto",
          serverEntrypoint: path.join(root, "server-entry.mjs"),
          supportedAstroFeatures: { serverOutput: "stable" },
        });
      },
    },
  };
  await build({
    root: pathToFileURL(`${root}${path.sep}`),
    cacheDir: path.join(root, ".astro"),
    outDir: "./dist",
    build: { server: path.join(root, ".server"), client: path.join(root, "dist") },
    vite: {
      cacheDir: path.join(root, ".vite"),
      resolve: {
        alias: [
          { find: /^@cloudflare\/nimbus-docs$/, replacement: path.join(SRC_DIR, "index.ts") },
          { find: /^@cloudflare\/nimbus-docs\//, replacement: `${SRC_DIR}/` },
        ],
      },
    },
    site: `https://${host}`,
    output: "server",
    adapter,
    integrations: [
      nimbus(
        {
          site: `https://${host}`,
          title: "Test",
          description: "A test site.",
          search: false,
          // Query versions need request rendering, so the build-rendered site
          // keeps that one collection on request; its documents still bake.
          rendering: rendering === "build" ? { default: "build", collections: { qv: "request" } } : { default: "request" },
          api: [
            { collection: "pets", spec: "./specs/pets.json" },
            {
              collection: "qv",
              versionUrl: { in: "query", param: "v" },
              versions: [
                { version: "v2", spec: "./specs/qv-v2.json", default: true },
                { version: "v1", spec: "./specs/qv-v1.json" },
                { version: "v0", spec: "./specs/qv-v0.json", hidden: true },
              ],
            },
            {
              collection: "pv",
              versions: [
                { version: "v2", spec: "./specs/pv-v2.json", default: true },
                { version: "v1", spec: "./specs/pv-v1.json" },
              ],
            },
          ],
        } as Parameters<typeof nimbus>[0],
        { admonitions: false, sitemap: false, validateMdx: false },
      ),
    ],
  } as never);
  assetRoots.set(host, { dir: path.join(root, "dist"), base: "/" });
  const { app } = (await import(pathToFileURL(path.join(root, ".server/entry.mjs")).href)) as { app: Site["app"] };
  return { root, app };
}

interface Manifest {
  llmsAssets: Array<{ scope: string; surface: string; section?: string; path: string }>;
  onRequest: { llms: boolean; llmsSections: boolean; llmsFull: boolean };
  pages?: Array<{ collection: string; id: string; url: string; title: string }>;
  buildId: string;
}

const manifestOf = async (site: Site): Promise<Manifest> =>
  JSON.parse(await readFile(path.join(site.root, ".astro/nimbus/agent-endpoint-assets/manifest.json"), "utf8")) as Manifest;

/** A build-rendered site's prerendered file. */
const bakedFile = (site: Site, url: string) => readFile(path.join(site.root, "dist", ...url.split("/").filter(Boolean)), "utf8");

const rehost = (body: string, from: string, to: string) => body.replaceAll(`https://${from}/`, `https://${to}/`);
const links = (body: string) => [...body.matchAll(/^- \[([^\]]*)\]\(([^)]+)\)(?: — (.*))?$/gm)].map((m) => [m[1], m[2], m[3] ?? ""]);
/** A full document's blocks: `# ` headings and what follows, in order. */
const blocks = (body: string) => body.split(/\n(?=# )/).map((block) => block.trimEnd());

const renders = () =>
  ((globalThis as unknown as Record<symbol, Record<string, number> | undefined>)[Symbol.for("nimbus.llms-on-request.renders")] ?? {}) as Record<string, number>;

let baked: Site;
let live: Site;
let bodiesOnly: Site;

before(async () => {
  [baked, live, bodiesOnly] = await Promise.all([
    buildSite("baked.test", "build"),
    buildSite("live.test", "request"),
    // No Markdown route and no MCP: nothing publishes a page's Markdown, yet
    // the parts still need every body.
    buildSite("bodies.test", "request", { markdownRoute: false }),
  ]);
});

after(async () => {
  await Promise.all([baked, live, bodiesOnly].filter(Boolean).map((site) => rm(site.root, { recursive: true, force: true, maxRetries: 5 })));
});

// Before any other test asks for a part: a cold render, shared by concurrent
// requests, then a memo hit.
test("a part is assembled once per isolate: concurrent requests share the render and the next request is a hit", async () => {
  const index = await (await live.app.render(new Request("https://live.test/llms-full.txt"))).text();
  const href = links(index).map(([, h]) => h!).find((h) => h.endsWith("/llms-full.txt"))!;
  const before = renders().part ?? 0;
  const [first, second] = await Promise.all([live.app.render(new Request(href)), live.app.render(new Request(href))]);
  assert.equal(first.status, 200);
  assert.equal(await first.text(), await second.text());
  assert.equal(renders().part, before + 1, "one cold render for two concurrent requests");
  const third = await live.app.render(new Request(href));
  assert.equal(third.status, 200);
  assert.equal(renders().part, before + 1, "a memo hit renders nothing");
});

test("with no Markdown route and no MCP, the parts still read every page's body", async () => {
  const manifest = await manifestOf(bodiesOnly);
  assert.deepEqual(manifest.onRequest, { llms: true, llmsSections: true, llmsFull: true });
  // The deployed manifest keeps the unpublished bodies the parts read.
  const deployed = JSON.parse(
    await readFile(path.join(bodiesOnly.root, "dist/_nimbus/agent-endpoint-assets/manifest.json"), "utf8"),
  ) as { markdownAssets: Array<{ collection: string; published?: false }> };
  assert.ok(deployed.markdownAssets.some((asset) => asset.collection === "docs" && asset.published === false));
  const index = await (await bodiesOnly.app.render(new Request("https://bodies.test/llms-full.txt"))).text();
  const partHrefs = links(index).map(([, h]) => h!).filter((h) => /\/llms-full\.txt(\?|$)/.test(h));
  const leaves = links(index).map(([, h]) => h!).filter((h) => !/\/llms-full\.txt(\?|$)/.test(h));
  let total = 0;
  for (const href of partHrefs) {
    const response = await bodiesOnly.app.render(new Request(href));
    assert.equal(response.status, 200, href);
    const body = await response.text();
    assert.match(body, /^# Test — /, href);
    const count = blocks(body).length - 1;
    assert.ok(count >= 1, `${href} holds its pages`);
    total += count;
    // No page links a Markdown URL: none is served.
    assert.doesNotMatch(body, /index\.md/);
  }
  assert.doesNotMatch(index, /index\.md/);
  // Every discoverable page is in exactly one part or linked from the index.
  assert.equal(total + leaves.length, manifest.pages!.length);
});

test("a query-versioned API gets one part per version, each holding that version's pages", async () => {
  const index = await (await live.app.render(new Request("https://live.test/llms-full.txt"))).text();
  const qvParts = links(index).filter(([, href]) => href!.includes("/qv/llms-full.txt"));
  assert.deepEqual(
    qvParts.map(([label, href]) => [label, new URL(href!).pathname + new URL(href!).search]),
    [
      ["Weather v2", "/qv/llms-full.txt"],
      ["Weather v2 (v1)", "/qv/llms-full.txt?v=v1"],
    ],
  );
  const before = renders().part ?? 0;
  const current = await (await live.app.render(new Request("https://live.test/qv/llms-full.txt"))).text();
  const historical = await (await live.app.render(new Request("https://live.test/qv/llms-full.txt?v=v1"))).text();
  assert.equal(renders().part, before + 2, "two parts, two renders: the cache keys carry the version");
  assert.match(current, /^# Test — Weather v2\n/);
  assert.match(current, /Get a forecast \(v2\)/);
  assert.doesNotMatch(current, /v1\)|\?v=v1|Legacy report/);
  assert.match(historical, /^# Test — Weather v2 \(v1\)\n/);
  assert.match(historical, /Get a forecast \(v1\)/);
  assert.match(historical, /Legacy report \(v1\)/);
  assert.doesNotMatch(historical, /\(v2\)/);
  // A historical page's URL carries its version; it has no Markdown URL.
  assert.match(historical, /Source: https:\/\/live\.test\/qv\/getForecast\/\?v=v1\n/);
  assert.doesNotMatch(historical, /index\.md/);
  // The same version twice is a hit; an unknown version is nothing.
  await live.app.render(new Request("https://live.test/qv/llms-full.txt?v=v1"));
  assert.equal(renders().part, before + 2);
  assert.equal((await live.app.render(new Request("https://live.test/qv/llms-full.txt?v=v9"))).status, 404);
  // A hidden version is listed nowhere and has no part.
  assert.doesNotMatch(index, /v=v0/);
  assert.equal((await live.app.render(new Request("https://live.test/qv/llms-full.txt?v=v0"))).status, 404);
  // The indexes list the default version only.
  const siteIndex = await (await live.app.render(new Request("https://live.test/llms.txt"))).text();
  assert.doesNotMatch(siteIndex, /\?v=v1/);
  const section = await (await live.app.render(new Request("https://live.test/qv/llms.txt"))).text();
  assert.match(section, /Get a forecast \(v2\)/);
  assert.doesNotMatch(section, /v1/);
});

test("a path-versioned API gets a part per version at the version's URL, its pages keeping their Markdown links", async () => {
  const index = await (await live.app.render(new Request("https://live.test/llms-full.txt"))).text();
  const pvParts = links(index).filter(([, href]) => href!.includes("/pv/"));
  assert.deepEqual(
    pvParts.map(([label, href]) => [label, new URL(href!).pathname]),
    [
      ["Radar v2", "/pv/llms-full.txt"],
      ["Radar v2 (v1)", "/pv/v1/llms-full.txt"],
    ],
  );
  const historical = await live.app.render(new Request("https://live.test/pv/v1/llms-full.txt"));
  assert.equal(historical.status, 200);
  const body = await historical.text();
  assert.match(body, /^# Test — Radar v2 \(v1\)\n/);
  assert.match(body, /Get a forecast \(v1\)/);
  assert.match(body, /Legacy report \(v1\)/);
  assert.doesNotMatch(body, /\(v2\)/);
  // A path version's pages have URLs and Markdown of their own.
  assert.match(body, /Source: https:\/\/live\.test\/pv\/v1\/getForecast\/ · Markdown: https:\/\/live\.test\/pv\/v1\/getForecast\/index\.md/);
  const current = await (await live.app.render(new Request("https://live.test/pv/llms-full.txt"))).text();
  assert.doesNotMatch(current, /\/pv\/v1\//);
  assert.equal((await live.app.render(new Request("https://live.test/pv/v9/llms-full.txt"))).status, 404);
  // The section index lists the path version's pages, as a build-rendered site's does.
  const section = await (await live.app.render(new Request("https://live.test/pv/llms.txt"))).text();
  assert.match(section, /\/pv\/v1\/getForecast\/index\.md/);
});

test("a section index on request still answers the default version only", async () => {
  assert.equal((await live.app.render(new Request("https://live.test/qv/llms.txt?v=v1"))).status, 404);
  assert.equal((await live.app.render(new Request("https://live.test/qv/llms.txt?v=v2"))).status, 200);
  // The legacy parameter selects a part too.
  const legacy = await live.app.render(new Request("https://live.test/qv/llms-full.txt?api-version=v1"));
  assert.equal(legacy.status, 200);
  assert.match(await legacy.text(), /\(v1\)\n/);
  assert.equal((await live.app.render(new Request("https://live.test/qv/llms-full.txt?v=v1&v=v2"))).status, 404);
});

test("a request-rendered site bakes no agent document and lists its pages in the manifest", async () => {
  const manifest = await manifestOf(live);
  assert.deepEqual(manifest.onRequest, { llms: true, llmsSections: true, llmsFull: true });
  assert.deepEqual(manifest.llmsAssets, []);
  assert.ok(manifest.pages && manifest.pages.length >= 11, "the discoverable pages, docs and API, historical versions included");
  assert.ok(manifest.pages.some((page) => (page as { historical?: true }).historical), "a historical version's pages travel for the parts");
  assert.match(manifest.buildId, /^[0-9a-f]{16}$/);
  const bakedManifest = await manifestOf(baked);
  assert.deepEqual(bakedManifest.onRequest, { llms: false, llmsSections: false, llmsFull: false });
  assert.equal(bakedManifest.pages, undefined, "a build-rendered site keeps its files and needs no page list");
  assert.ok(bakedManifest.llmsAssets.length > 0);
});

test("/llms.txt renders the build-rendered index: same pages, order, titles, descriptions and links", async () => {
  const response = await live.app.render(new Request("https://live.test/llms.txt"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") ?? "", /^text\/plain/);
  assert.match(response.headers.get("ETag") ?? "", /^"sha256:[0-9a-f]{64}"$/);
  const body = await response.text();
  const expected = rehost(await bakedFile(baked, "/llms.txt"), "baked.test", "live.test");
  assert.deepEqual(links(body), links(expected));
  // The only sentence that may differ says whether the full document is one file or parts.
  assert.equal(
    body.replace(/^Full documentation .*$/m, "FULL"),
    expected.replace(/^Full documentation .*$/m, "FULL"),
  );
  assert.match(body, /^Full documentation \(discoverable current pages, split by section\)/m);
});

test("each section index renders the build-rendered one", async () => {
  const expectedIndex = rehost(await bakedFile(baked, "/llms.txt"), "baked.test", "live.test");
  const sections = links(expectedIndex)
    .map(([, href]) => href!)
    .filter((href) => href.endsWith("/llms.txt"))
    .map((href) => new URL(href).pathname);
  assert.ok(sections.length >= 2, `sections: ${sections.join(", ")}`);
  for (const pathname of sections) {
    const response = await live.app.render(new Request(`https://live.test${pathname}`));
    assert.equal(response.status, 200, pathname);
    const body = await response.text();
    // The build-rendered site's file, or, for its one request-rendered mount, its served asset.
    const file = path.join(baked.root, "dist", ...pathname.split("/").filter(Boolean));
    const expected = existsSync(file)
      ? await readFile(file, "utf8")
      : await (await baked.app.render(new Request(`https://baked.test${pathname}`))).text();
    assert.equal(body, rehost(expected, "baked.test", "live.test"), pathname);
  }
  const unknown = await live.app.render(new Request("https://live.test/nowhere/llms.txt"));
  assert.equal(unknown.status, 404);
});

test("/llms-full.txt is an index of parts; every part resolves and their blocks are the build-rendered document's", async () => {
  const index = await live.app.render(new Request("https://live.test/llms-full.txt"));
  assert.equal(index.status, 200);
  const indexBody = await index.text();
  assert.match(indexBody, /^# Test\n\n> The full documentation is served by section/);
  assert.match(indexBody, /^Index: https:\/\/live\.test\/llms\.txt$/m);
  const allParts = links(indexBody).map(([, href]) => href!).filter((href) => /\/llms-full\.txt(\?|$)/.test(href));
  const partUrls = allParts.filter((href) => !href.includes("?"));
  const pageUrls = links(indexBody).map(([, href]) => href!).filter((href) => !/\/llms-full\.txt(\?|$)/.test(href));
  assert.ok(partUrls.length >= 2, indexBody);
  assert.doesNotMatch(indexBody, /\(\d+(\.\d+)? [KM]iB\)/, "parts are listed without sizes");

  const partBlocks: string[] = [];
  for (const href of partUrls) {
    const response = await live.app.render(new Request(href));
    assert.equal(response.status, 200, href);
    const body = await response.text();
    assert.match(body, /^# Test — /, href);
    partBlocks.push(...blocks(body).slice(1));
  }
  // Pages the index links directly (top-level leaves) are not in any part.
  const expectedFull = rehost(await bakedFile(baked, "/llms-full.txt"), "baked.test", "live.test");
  const expectedBlocks = blocks(expectedFull).slice(1);
  const leafTitles = pageUrls.length;
  assert.equal(
    partBlocks.length + leafTitles,
    expectedBlocks.length,
    `every page is in exactly one part or linked from the index\nparts: ${partBlocks.map((b) => b.split("\n")[0]).join(" | ")}\nleaves: ${pageUrls.join(", ")}\nexpected: ${expectedBlocks.map((b) => b.split("\n")[0]).join(" | ")}\nindex:\n${indexBody}`,
  );
  const normalize = (block: string) => block.replace(/\n+$/, "");
  const expectedSet = new Set(expectedBlocks.map(normalize));
  for (const block of partBlocks) assert.ok(expectedSet.has(normalize(block)), `block not in the build-rendered document:\n${block.slice(0, 300)}`);
});
