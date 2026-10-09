// `schemaPages: false` through `astro build`, prerendered and request-rendered:
// no schema route, Markdown file, sitemap entry, llms entry, or coordinate
// exists, and operation pages render their union variants without links.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import { build, type AstroIntegration } from "astro";

import nimbus from "../src/index.ts";
import { runningNimbusVersion } from "../src/_internal/upgrades.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10 })));
});

const moduleUrl = (relative: string) =>
  JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, relative)).href);
const SPEC = path.resolve(import.meta.dirname, "fixtures/api/smallco.yaml");

// Request rendering is gated to the Cloudflare adapter; this stand-in takes its
// name and serves Astro's generated App directly.
function testAdapter(entrypoint: string): AstroIntegration {
  return {
    name: "@astrojs/cloudflare",
    hooks: {
      "astro:config:done": ({ setAdapter }) => {
        setAdapter({
          name: "@astrojs/cloudflare",
          entrypointResolution: "auto",
          serverEntrypoint: entrypoint,
          supportedAstroFeatures: { serverOutput: "stable" },
        });
      },
    },
  };
}

// Renders every union variant the way the starter's union explorer does: a link
// and a "View … schema" link only when the variant has an href.
const PAGE = `---
import { getApiRoute, getApiStaticPaths } from ${moduleUrl("../src/runtime.ts")};
export const prerender = true;
export const getStaticPaths = getApiStaticPaths("api");
const result = await getApiRoute(Astro);
if (result instanceof Response) return result;
const { page } = result;
const unions = page.kind === "operation"
  ? [page.bodyUnion, ...page.body.map((f) => f.union), ...page.responses.map((r) => r.bodyUnion)].filter(Boolean)
  : [];
---
<main data-kind={page.kind}>{unions.flatMap((u) => u.variants).map((v) => v.href
  ? <p><a href={v.href} class="variant">{v.label}</a><a href={v.href}>View {v.label} schema →</a></p>
  : <p><span class="variant">{v.label}</span></p>)}</main>`;

interface Site {
  dist: string;
  get(pathname: string): Promise<{ status: number; body: string }>;
}

async function buildSite(schemaPages: boolean, request: boolean): Promise<Site> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-schema-pages-"));
  roots.push(root);
  const write = async (relative: string, contents: string) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents, "utf8");
  };
  await symlink(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await write("nimbus.json", `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`);
  await write(
    "src/content.config.ts",
    `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection } from ${moduleUrl("../src/content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  api: defineCollection(apiCollection()),
};`,
  );
  await write("src/content/docs/guide.md", "---\ntitle: Guide\n---\n\nText.\n");
  await write("src/pages/api/[...slug].astro", PAGE);
  await write(
    "src/pages/[...slug].astro",
    `---\nimport { getDocsStaticPaths } from ${moduleUrl("../src/runtime.ts")};\nexport const prerender = true;\nexport const getStaticPaths = getDocsStaticPaths;\n---\n<p>doc</p>`,
  );
  await write(
    "src/pages/[...slug]/index.md.ts",
    `import { markdownRoute } from ${moduleUrl("../src/agent-endpoints.ts")};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = markdownRoute();`,
  );
  await write(
    "src/pages/llms.txt.ts",
    `import { llmsRoute } from ${moduleUrl("../src/agent-endpoints.ts")};\nexport const prerender = true;\nexport const { GET } = llmsRoute();`,
  );
  await write(
    "src/pages/[section]/llms.txt.ts",
    `import { llmsSectionRoute } from ${moduleUrl("../src/agent-endpoints.ts")};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = llmsSectionRoute();`,
  );
  await write(
    "src/pages/llms-full.txt.ts",
    `import { llmsFullRoute } from ${moduleUrl("../src/agent-endpoints.ts")};\nexport const prerender = true;\nexport const { GET } = llmsFullRoute();`,
  );
  await write(
    "src/pages/nimbus-api/coordinates.json.ts",
    `import { getCoordinatesManifest } from ${moduleUrl("../src/runtime.ts")};\nexport const prerender = true;\nexport async function GET() { return new Response(JSON.stringify(await getCoordinatesManifest())); }`,
  );
  let adapter: AstroIntegration | undefined;
  if (request) {
    await write(
      "server-entry.mjs",
      `import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n`,
    );
    adapter = testAdapter(path.join(root, "server-entry.mjs"));
  }
  await build({
    root: pathToFileURL(`${root}${path.sep}`),
    cacheDir: path.join(root, ".astro"),
    outDir: "./dist",
    build: { server: path.join(root, ".server"), client: path.join(root, "dist") },
    vite: { cacheDir: path.join(root, ".vite") },
    ...(adapter ? { output: "server" as const, adapter } : {}),
    logLevel: "silent",
    integrations: [
      nimbus(
        {
          site: "https://example.test",
          title: "Test",
          description: "Test",
          search: false,
          api: [{ collection: "api", spec: SPEC, schemaPages }],
          ...(request ? { rendering: { default: "build", collections: { api: "request" } } } : {}),
        },
        { admonitions: false, validateMdx: false },
      ),
    ],
  });

  const dist = path.join(root, "dist");
  if (!request) {
    return {
      dist,
      async get(pathname) {
        try {
          return { status: 200, body: await readFile(path.join(dist, pathname, "index.html"), "utf8") };
        } catch {
          return { status: 404, body: "" };
        }
      },
    };
  }
  const { app } = (await import(pathToFileURL(path.join(root, ".server/entry.mjs")).href)) as {
    app: { render(request: Request): Promise<Response> };
  };
  return {
    dist,
    async get(pathname) {
      const response = await app.render(new Request(`https://example.test${pathname}`));
      return { status: response.status, body: await response.text() };
    },
  };
}

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
}

async function sitemapUrls(dist: string): Promise<string[]> {
  const out: string[] = [];
  for (const file of (await readdir(dist)).filter((f) => /^sitemap-\d+\.xml$/.test(f))) {
    const xml = await readFile(path.join(dist, file), "utf8");
    out.push(...[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!));
  }
  return out;
}

const OPERATIONS = ["/api/charges/create/", "/api/disputes/openDispute/"];

describe("schemaPages: false, prerendered", () => {
  let on: Site;
  let off: Site;
  before(async () => {
    on = await buildSite(true, false);
    off = await buildSite(false, false);
  });

  test("default publishes schema pages (control)", async () => {
    const all = await files(on.dist);
    assert.ok(all.some((f) => f.startsWith("api/schemas/") && f.endsWith("index.html")));
    assert.ok(all.some((f) => f.startsWith("api/schemas/") && f.endsWith("index.md")));
    assert.ok((await sitemapUrls(on.dist)).some((u) => u.includes("/api/schemas/")));
  });

  test("no schema route, Markdown file, or sitemap entry", async () => {
    const all = await files(off.dist);
    assert.deepEqual(all.filter((f) => f.includes("schemas/")), []);
    const urls = await sitemapUrls(off.dist);
    assert.ok(urls.some((u) => u.includes("/api/charges/create")), "operations stay in the sitemap");
    assert.deepEqual(urls.filter((u) => u.includes("/schemas/")), []);
    // Every other output file is still produced.
    const expected = (await files(on.dist)).filter((f) => !f.includes("schemas/") && !/^sitemap|_astro\//.test(f));
    const actual = new Set(all);
    assert.deepEqual(expected.filter((f) => !actual.has(f)), []);
  });

  test("llms outputs and coordinates.json leave schemas out", async () => {
    const read = (site: Site, file: string) => readFile(path.join(site.dist, file), "utf8");
    for (const file of ["api/llms.txt", "llms-full.txt"]) {
      assert.match(await read(on, file), /\/api\/schemas\//, `${file}: control lists schema pages`);
      assert.doesNotMatch(await read(off, file), /\/api\/schemas\//, file);
    }
    const manifest = await read(off, "nimbus-api/coordinates.json");
    assert.match(await read(on, "nimbus-api/coordinates.json"), /"Dispute"/, "control lists schema coordinates");
    assert.doesNotMatch(manifest, /"(Dispute|Card|Charge)(\.[^"]*)?"/);
    assert.match(manifest, /"create"/);
  });

  test("operation pages render variants as text, with no View schema link", async () => {
    for (const pathname of OPERATIONS) {
      const page = await off.get(pathname);
      assert.equal(page.status, 200, pathname);
      assert.match(page.body, /<span class="variant">/);
      assert.doesNotMatch(page.body, /View \w+ schema →/);
      assert.doesNotMatch(page.body, /\/schemas\//);
      assert.match((await on.get(pathname)).body, /View \w+ schema →/, "control links variants");
    }
  });
});

describe("schemaPages: false, request-rendered", () => {
  let off: Site;
  let staticOff: Site;
  before(async () => {
    off = await buildSite(false, true);
    staticOff = await buildSite(false, false);
  });

  test("schema URLs 404 and operation pages match the prerendered output", async () => {
    assert.equal((await off.get("/api/schemas/Dispute/")).status, 404);
    for (const pathname of OPERATIONS) {
      const live = await off.get(pathname);
      assert.equal(live.status, 200, pathname);
      const main = (html: string) => /<main[\s\S]*<\/main>/.exec(html)?.[0];
      assert.equal(main(live.body), main((await staticOff.get(pathname)).body), pathname);
    }
  });
});
