// Discovery lists every visible API version, under a base: query-addressed
// versions with a custom parameter, `bundle: false` versions, and versions
// whose spec isn't published. One real server build; the assertions read the
// discovery files it writes.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, before, after } from "node:test";
import { build, type AstroIntegration } from "astro";
import nimbus from "../src/index.ts";
import { runningNimbusVersion } from "../src/_internal/upgrades.ts";
import { TEST_TMP } from "./fixtures/temp-root.js";

const SRC_DIR = path.resolve(import.meta.dirname, "../src");
const ORIGIN = "https://example.test/docs";

function spec(title: string): string {
  return JSON.stringify({
    openapi: "3.0.0",
    info: { title, version: "1.0.0" },
    paths: { "/pets": { get: { operationId: "list-pets", summary: "List pets", responses: { "200": { description: "ok" } } } } },
  });
}

const page = (collection: string) => `---
import { getApiRoute, getApiStaticPaths } from "@cloudflare/nimbus-docs/runtime";
export const prerender = true;
export const getStaticPaths = getApiStaticPaths(${JSON.stringify(collection)});
const result = await getApiRoute(Astro);
if (result instanceof Response) return result;
---
<html><body>{result.page.title}</body></html>
`;

const versions = (family: string) => [
  { version: "v2", spec: `./specs/${family}-v2.json`, default: true },
  { version: "v1", spec: `./specs/${family}-v1.json` },
  { version: "v0", spec: `./specs/${family}-v0.json`, hidden: true },
  { version: "v9", spec: `./specs/${family}-v9.json`, publishSpec: false },
];

let root: string;
let files: Map<string, string>;

before(async () => {
  // Astro recognises src/live.config.ts by its real path.
  root = await realpath(await mkdtemp(path.join(TEST_TMP, "nimbus-api-discovery-versions-")));
  const write = async (file: string, body: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), body);
  };
  await symlink(path.resolve(import.meta.dirname, "../node_modules"), path.join(root, "node_modules"), "dir");
  await write("package.json", '{"type":"module"}');
  await write("nimbus.json", `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`);
  for (const family of ["qv", "big", "pets"])
    for (const version of ["v2", "v1", "v0", "v9"]) await write(`specs/${family}-${version}.json`, spec(`${family} ${version}`));
  const content = pathToFileURL(path.join(SRC_DIR, "content.ts")).href;
  await write(
    "src/content.config.ts",
    `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection } from ${JSON.stringify(content)};
export const collections = {
  docs: defineCollection(docsCollection()),
  qv: defineCollection(apiCollection()),
  big: defineCollection(apiCollection()),
  pets: defineCollection(apiCollection()),
};`,
  );
  // `bundle: false` reads pages through a live collection.
  await write(
    "src/live.config.ts",
    `import { defineLiveCollection } from "astro:content";
import { apiPagesLoader } from "@cloudflare/nimbus-docs/live";
export const collections = { apiPages: defineLiveCollection({ loader: apiPagesLoader() }) };`,
  );
  await write("src/content/docs/guide.md", "---\ntitle: Guide\n---\n\nText.\n");
  await write("src/pages/index.astro", "<html><body><h1>Home</h1></body></html>\n");
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
  for (const collection of ["qv", "big", "pets"]) await write(`src/pages/${collection}/[...slug].astro`, page(collection));
  // Page Markdown is published only where a route serves it.
  await write(
    "src/pages/[...slug]/index.md.ts",
    `import { markdownRoute } from "@cloudflare/nimbus-docs/agent-endpoints";
export const { GET, getStaticPaths } = markdownRoute();
`,
  );
  // Each API page's section, as the starter's share cards ask for it.
  await write(
    "src/pages/sections.json.ts",
    `import { getIndexedEntries, getPageSection } from "@cloudflare/nimbus-docs/runtime";
export const prerender = true;
export async function GET() {
  const sections = {};
  for (const page of await getIndexedEntries()) sections[page.url] = (await getPageSection(page)) ?? null;
  return new Response(JSON.stringify(sections));
}
`,
  );
  await write("server-entry.mjs", 'import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n');

  // The request-rendering gate string-matches the adapter name; the test
  // adapter is Astro's generated App behind a plain entrypoint.
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
    base: "/docs",
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
    output: "server",
    adapter,
    logLevel: "silent",
    integrations: [
      nimbus(
        {
          site: "https://example.test",
          title: "Test",
          description: "Test",
          search: false,
          rendering: { default: "build", collections: { qv: "request", big: "request" } },
          api: [
            { collection: "qv", versionUrl: { in: "query", param: "v" }, versions: versions("qv") },
            { collection: "big", bundle: false, versions: versions("big") },
            {
              collection: "pets",
              versions: [
                { version: "v2", spec: "./specs/pets-v2.json", default: true, publishSpec: false },
                { version: "v1", spec: "./specs/pets-v1.json" },
              ],
            },
          ],
        } as Parameters<typeof nimbus>[0],
        { admonitions: false, sitemap: false, validateMdx: false },
      ),
    ],
  } as never);

  // Index every file the build wrote, wherever the adapter put it.
  files = new Map();
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".server" && entry.name !== "specs") await walk(full);
      } else files.set(path.relative(root, full).split(path.sep).join("/"), full);
    }
  };
  await walk(root);
});

after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

/** The one written file whose path ends with `suffix`. */
async function output(suffix: string): Promise<string> {
  const matches = [...files.keys()].filter((file) => file.endsWith(suffix) && !file.startsWith("src/"));
  assert.ok(matches.length > 0, `no output file ends with ${suffix}`);
  return readFile(files.get(matches[0]!)!, "utf8");
}

function published(suffix: string): boolean {
  return [...files.keys()].some((file) => file.endsWith(suffix) && !file.startsWith("src/"));
}

type Entry = { anchor: string; "service-desc"?: Array<{ href: string }>; "service-doc": Array<{ href: string; type: string }> };

test("the catalog lists every visible version at an absolute URL under the base", async () => {
  const catalog = JSON.parse(await output(".well-known/api-catalog")) as { linkset: Entry[] };
  const byAnchor = new Map(catalog.linkset.map((entry) => [entry.anchor, entry]));
  assert.deepEqual([...byAnchor.keys()].sort(), [
    `${ORIGIN}/big/`,
    `${ORIGIN}/big/v1/`,
    `${ORIGIN}/big/v9/`,
    `${ORIGIN}/pets/`,
    `${ORIGIN}/pets/v1/`,
    `${ORIGIN}/qv/`,
    `${ORIGIN}/qv/?v=v1`,
    `${ORIGIN}/qv/?v=v9`,
  ]);
  const types = (anchor: string) => byAnchor.get(anchor)!["service-doc"].map((doc) => doc.type);
  const desc = (anchor: string) => byAnchor.get(anchor)!["service-desc"]?.map((d) => d.href);

  // Non-default versions in query mode or under bundle: false have no Markdown.
  for (const anchor of [`${ORIGIN}/qv/?v=v1`, `${ORIGIN}/qv/?v=v9`, `${ORIGIN}/big/v1/`, `${ORIGIN}/big/v9/`])
    assert.deepEqual(types(anchor), ["text/html"], anchor);
  // Defaults and bundled path-mode versions keep it, with or without a spec.
  for (const anchor of [`${ORIGIN}/qv/`, `${ORIGIN}/big/`, `${ORIGIN}/pets/`, `${ORIGIN}/pets/v1/`])
    assert.deepEqual(types(anchor), ["text/html", "text/markdown"], anchor);

  assert.deepEqual(desc(`${ORIGIN}/qv/?v=v1`), [`${ORIGIN}/qv/v1/openapi.json`]);
  assert.deepEqual(desc(`${ORIGIN}/big/v1/`), [`${ORIGIN}/big/v1/openapi.json`]);
  for (const anchor of [`${ORIGIN}/qv/?v=v9`, `${ORIGIN}/big/v9/`, `${ORIGIN}/pets/`])
    assert.equal(desc(anchor), undefined, anchor);
  assert.doesNotMatch(JSON.stringify(catalog), /v0/);
});

test("every advertised Markdown URL is served", async () => {
  const catalog = JSON.parse(await output(".well-known/api-catalog")) as { linkset: Entry[] };
  const manifest = JSON.parse(await output(".astro/nimbus/agent-endpoint-assets/manifest.json")) as {
    markdownAssets: Array<{ url: string; path: string }>;
  };
  const served = new Map(manifest.markdownAssets.map((asset) => [asset.url, asset.path]));
  const advertised = catalog.linkset.flatMap((entry) =>
    entry["service-doc"].filter((doc) => doc.type === "text/markdown").map((doc) => doc.href),
  );
  assert.equal(advertised.length, 4);
  for (const href of advertised) {
    const asset = served.get(href.slice(ORIGIN.length));
    assert.ok(asset, `${href} has no Markdown asset`);
    assert.ok(published(`dist/_nimbus/agent-endpoint-assets/${asset}`), `${href} asset not in dist`);
  }
});

test("specs publish for every version that allows it, hidden ones included, with no discovery for hidden", async () => {
  for (const family of ["qv", "big"]) {
    for (const version of ["v1", "v0"])
      assert.match(await output(`${family}/${version}/openapi.json`), new RegExp(`${family} ${version}`));
    assert.equal(published(`${family}/v9/openapi.json`), false, `${family} v9 opted out`);
  }
  assert.equal(published("pets/openapi.json"), false, "pets default opted out");

  const ard = JSON.parse(await output(".well-known/ard.json")) as { entries: Array<{ url: string }> };
  const specs = ard.entries.map((entry) => entry.url).filter((url) => url.endsWith("openapi.json")).sort();
  assert.deepEqual(specs, [
    `${ORIGIN}/big/openapi.json`,
    `${ORIGIN}/big/v1/openapi.json`,
    `${ORIGIN}/pets/v1/openapi.json`,
    `${ORIGIN}/qv/openapi.json`,
    `${ORIGIN}/qv/v1/openapi.json`,
  ]);
});

test("the homepage Link header advertises only defaults and the complete catalog", async () => {
  const headers = await output("_headers");
  assert.ok(headers.includes('<https://example.test/.well-known/api-catalog>; rel="api-catalog"'), headers);
  for (const family of ["qv", "big", "pets"])
    assert.ok(headers.includes(`<${ORIGIN}/${family}/>; rel="service-doc"`), headers);
  for (const family of ["qv", "big"])
    assert.ok(headers.includes(`<${ORIGIN}/${family}/openapi.json>; rel="service-desc"`), headers);
  assert.doesNotMatch(headers, /(?:\?v=v[19]|\/v[19]\/).*?>; rel="service-/);
  assert.ok(!headers.includes(`<${ORIGIN}/pets/openapi.json>; rel="service-desc"`));
  // Non-default specs still receive content-type rules even though homepage links omit them.
  assert.match(headers, /\/big\/v1\/openapi\.json\n {2}Content-Type: application\/vnd\.oai\.openapi\+json/);
  assert.doesNotMatch(headers, /v0\/>|v0\/openapi\.json>|\?v=v0/);
  // Hidden specs keep their media-type rule.
  assert.match(headers, /\/qv\/v0\/openapi\.json\n {2}Content-Type: application\/vnd\.oai\.openapi\+json/);
});

test("getPageSection reads bundle: false, prepared and query-mode API pages", async () => {
  const sections = JSON.parse(await output("sections.json")) as Record<string, string | null>;
  // An untagged operation's parent is its API's root, titled by the spec.
  assert.deepEqual(
    {
      big: sections["/big/list-pets/"],
      pets: sections["/pets/list-pets/"],
      qv: sections["/qv/list-pets/"],
      root: sections["/big/"],
      docs: sections["/guide/"],
    },
    { big: "big v2", pets: "pets v2", qv: "qv v2", root: null, docs: null },
  );
});
