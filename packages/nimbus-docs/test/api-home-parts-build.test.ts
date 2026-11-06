// The API home's later parts, end to end: a route that passes no
// `homeChunkSize` builds the home as one page, as before parts existed, and a
// built route that passes different sizes to its two helpers fails the build.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";

import { agentSites, SMALLCO_SPEC, srcModule } from "./fixtures/agent-site.ts";

const sites = agentSites();
after(() => sites.cleanup());

const runtime = JSON.stringify("@cloudflare/nimbus-docs/runtime");

const route = (staticPaths: string, routeOptions: string) => `---
import { getApiRoute, getApiStaticPaths } from ${runtime};
export const prerender = true;
export const getStaticPaths = getApiStaticPaths("api"${staticPaths});
const result = await getApiRoute(Astro${routeOptions});
if (result instanceof Response) return result;
const parts = result.home?.parts.map((part) => part.href) ?? [];
---
<script type="application/json" data-parts set:html={JSON.stringify(parts)} />
`;

const files = (apiRoute: string) => ({
  "src/content.config.ts": `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection } from ${srcModule("content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  api: defineCollection(apiCollection()),
};`,
  "src/content/docs/index.mdx": "---\ntitle: Home\n---\nHome.\n",
  "src/pages/api/[...slug].astro": apiRoute,
});

const options = { packageImports: true, api: [{ collection: "api", spec: SMALLCO_SPEC }] };

async function homeParts(root: string): Promise<string[]> {
  const html = await readFile(path.join(root, "dist", "api", "index.html"), "utf8");
  return JSON.parse(/<script type="application\/json" data-parts>(.*?)<\/script>/.exec(html)![1]!);
}

// More endpoints than the starter's 150, so a default size would split them.
const largeSpec = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Large", version: "1" },
  paths: Object.fromEntries(
    Array.from({ length: 151 }, (_, n) => [
      `/things/${n}`,
      { get: { operationId: `get${n}`, responses: { "200": { description: "OK" } } } },
    ]),
  ),
});

test("without homeChunkSize, the home is one page with no later parts", async () => {
  const site = await sites.buildSite(
    { ...files(route("", "")), "src/api/large.json": largeSpec },
    { ...options, api: [{ collection: "api", spec: "./src/api/large.json" }] },
  );
  assert.deepEqual(await homeParts(site.root), ["/api/"]);
  assert.equal(existsSync(path.join(site.root, "dist", "api", "index", "2")), false);
});

test("the same homeChunkSize in both helpers builds every part", async () => {
  const site = await sites.buildSite(files(route(", { homeChunkSize: 2 }", ", { homeChunkSize: 2 }")), options);
  const parts = await homeParts(site.root);
  assert.ok(parts.length > 1);
  for (const href of parts.slice(1)) {
    assert.ok(existsSync(path.join(site.root, "dist", href, "index.html")), href);
  }
});

test("a built route with different sizes in its two helpers fails the build", async () => {
  await assert.rejects(
    sites.buildSite(files(route(", { homeChunkSize: 2 }", "")), options),
    /homeChunkSize is 2 in getApiStaticPaths\("api"\) but unset in getApiRoute\. Pass API_HOME_CHUNK_SIZE to both/,
  );
  await assert.rejects(
    sites.buildSite(files(route("", ", { homeChunkSize: 2 }")), options),
    /homeChunkSize is unset in getApiStaticPaths\("api"\) but 2 in getApiRoute\. Pass API_HOME_CHUNK_SIZE to both/,
  );
});

// The starter's ApiLayout builds the home's table of contents from the
// version's whole index (`page.index`), drops headings no part renders, and
// links a heading in a later part to that part (`anchorParts`). ApiHome renders
// each part's own headings (`home.part`). This route does both, the same way.
const tocRoute = `---
import { getApiRoute, getApiStaticPaths } from ${runtime};
export const prerender = true;
export const getStaticPaths = getApiStaticPaths("api", { homeChunkSize: 2 });
const result = await getApiRoute(Astro, { homeChunkSize: 2 });
if (result instanceof Response) return result;
const { page, home } = result;
const ids = home
  ? [
      ...home.part.groups.flatMap((g) => [...(g.label && !g.continued ? [g.anchor] : []), ...g.sections.map((s) => s.anchor)]),
      ...(home.part.operations ? [home.part.operations.anchor] : []),
      ...(home.part.webhooks ? [home.part.webhooks.anchor] : []),
    ]
  : [];
const headings = page.kind === "api" && home && home.part.number === 1
  ? [
      ...page.index.groups.flatMap((g) => [...(g.label ? [g.anchor] : []), ...g.sections.map((s) => s.anchor)]),
      ...(page.index.operations.length > 0 ? ["endpoints"] : []),
      ...(page.index.webhooks.length > 0 ? ["webhooks"] : []),
    ]
  : [];
const links = headings
  .filter((slug) => Object.hasOwn(home.anchorParts, slug))
  .map((slug) => {
    const n = home.anchorParts[slug];
    return (n > 1 ? home.parts[n - 1].href : "") + "#" + slug;
  });
---
{ids.map((id) => <h2 id={id}>{id}</h2>)}
{links.map((href) => <a data-toc href={href}>{href}</a>)}
<script type="application/json" data-headings set:html={JSON.stringify(headings)} />
`;

// Tagged operations across three tags, an `x-tagGroups` category with no tags
// that exist, and untagged operations, so the home splits into several parts.
const tocSpec = (version: string) =>
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Toc", version },
    tags: [{ name: "Pets" }, { name: "Stores" }, { name: "Users" }],
    "x-tagGroups": [
      { name: "Core", tags: ["Pets", "Stores"] },
      { name: "Accounts", tags: ["Users"] },
      { name: "Empty", tags: ["Missing"] },
    ],
    paths: Object.fromEntries(
      ["Pets", "Pets", "Stores", "Stores", "Users", "Users", null, null].map((tag, n) => [
        `/things/${n}`,
        { get: { operationId: `get${n}`, ...(tag ? { tags: [tag] } : {}), responses: { "200": { description: "OK" } } } },
      ]),
    ),
  });

async function auditToc(site: { root: string }, homeHref: string) {
  const read = (href: string) => {
    const url = new URL(href, "https://x.test");
    const dir = url.searchParams.get("version") ? `${url.pathname}` : url.pathname;
    return readFile(path.join(site.root, "dist", dir, "index.html"), "utf8");
  };
  const home = await read(homeHref);
  const links = [...home.matchAll(/<a data-toc href="([^"]+)"/g)].map((m) => m[1]!.replaceAll("&amp;", "&"));
  const headings: string[] = JSON.parse(/<script type="application\/json" data-headings>(.*?)<\/script>/.exec(home)![1]!);
  assert.ok(links.some((href) => !href.startsWith("#")), "some heading lives in a later part");
  assert.ok(headings.some((slug) => !links.some((href) => href.endsWith(`#${slug}`))), "the empty group gets no link");
  for (const href of links) {
    const [page, id] = href.split("#") as [string, string];
    const html = page ? await read(page) : home;
    assert.match(html, new RegExp(`id="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), href);
  }
  return links;
}

test("every heading the home lists links to the part that holds it, and an empty tag group gets no link", async () => {
  const site = await sites.buildSite(
    { ...files(tocRoute), "src/api/toc.json": tocSpec("1") },
    { ...options, api: [{ collection: "api", spec: "./src/api/toc.json" }] },
  );
  await auditToc(site, "/api/");
});

test("with path versions, each version's home links to its own parts", async () => {
  const site = await sites.buildSite(
    { ...files(tocRoute), "src/api/v2.json": tocSpec("2"), "src/api/v1.json": tocSpec("1") },
    {
      ...options,
      api: [
        {
          collection: "api",
          versionUrl: { in: "path" },
          versions: [
            { version: "v2", spec: "./src/api/v2.json", default: true },
            { version: "v1", spec: "./src/api/v1.json" },
          ],
        },
      ],
    },
  );
  await auditToc(site, "/api/");
  const v1 = await auditToc(site, "/api/v1/");
  assert.ok(v1.every((href) => href.startsWith("#") || href.startsWith("/api/v1/")), v1.join(" "));
});
