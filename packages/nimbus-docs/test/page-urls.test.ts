// Page URLs: the page helpers and `IndexedEntry` share one path function, and
// every `ogImageUrl` is exactly the file the starter's astro-og-canvas route
// writes for its `getOgImagePages()` key.

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import { ogImagePageKey, pageUrls } from "../src/_internal/page-urls.ts";
import { ogCardConfig } from "../../nimbus-starter-source/src/pages/og/_og-card-config.ts";
import { agentManifest, agentSites, SMALLCO_SPEC, srcModule } from "./fixtures/agent-site.ts";

const starterRequire = createRequire(
  path.resolve(import.meta.dirname, "../../nimbus-starter-source/package.json"),
);
const { OGImageRoute } = (await import(
  pathToFileURL(starterRequire.resolve("astro-og-canvas")).href
)) as typeof import("astro-og-canvas");

/** The files the starter's `og/[...slug].ts` writes for these `pages` keys. */
async function writtenOgImages(keys: readonly string[]): Promise<string[]> {
  const { getStaticPaths } = await OGImageRoute({
    pages: Object.fromEntries(keys.map((key) => [key, {}])),
    getImageOptions: () => ({ title: "", ...ogCardConfig }),
  });
  const paths = (await getStaticPaths({
    routePattern: "/og/[...slug]",
  } as Parameters<typeof getStaticPaths>[0])) as Array<{ params: { slug: string } }>;
  return paths.map(({ params }) => `/og/${params.slug}`);
}

test("pageUrls derives every URL from the served route", () => {
  assert.deepEqual(pageUrls("", { id: "index", body: "x" }), {
    url: "/",
    markdownUrl: "/index.md",
    sourceUrl: "/index.mdx",
    ogImageUrl: "/og/index.png",
  });
  assert.deepEqual(pageUrls("/blog", { id: "index", body: "x" }), {
    url: "/blog/",
    markdownUrl: "/blog/index.md",
    sourceUrl: "/blog/index.mdx",
    ogImageUrl: "/og/blog.png",
  });
  assert.deepEqual(pageUrls("/v1", { id: "guides/index", body: "" }), {
    url: "/v1/guides/",
    markdownUrl: "/v1/guides/index.md",
    sourceUrl: undefined,
    ogImageUrl: "/og/v1/guides.png",
  });
  assert.equal(ogImagePageKey("/og/v1.2/guide.png"), "v1.2/guide.png");
});

test("astro-og-canvas writes each key's card at the page's ogImageUrl, with no collisions", async () => {
  const pages: Array<[string, string]> = [
    ["", "index"],
    ["", "guides"],
    ["", "section/index"],
    ["", "1.1.1.1/encryption"],
    ["/blog", "index"],
    ["/blog", "post"],
    ["/v1", "index"],
    ["/v1.2", "guide"],
    ["/v1.2", "index"],
    ["/api", "charges/create"],
  ];
  const urls = pages.map(([prefix, id]) => pageUrls(prefix, { id }).ogImageUrl);
  assert.deepEqual(urls, [
    "/og/index.png",
    "/og/guides.png",
    "/og/section.png",
    "/og/1.1.1.1/encryption.png",
    "/og/blog.png",
    "/og/blog/post.png",
    "/og/v1.png",
    "/og/v1.2/guide.png",
    "/og/v1.2.png",
    "/og/api/charges/create.png",
  ]);
  assert.deepEqual(await writtenOgImages(urls.map(ogImagePageKey)), urls);
  assert.equal(new Set(urls).size, urls.length);
});

const sites = agentSites();
after(() => sites.cleanup());

const runtime = srcModule("runtime.ts");

interface PageRecord {
  collection: string;
  id: string;
  page: { markdownUrl: string; sourceUrl: string | undefined; ogImageUrl: string };
  hand: { markdownUrl: string; sourceUrl: string; ogImageUrl: string };
}

interface IndexedRecord {
  collection: string;
  id: string;
  url: string;
  markdownUrl: string;
  sourceUrl: string | undefined;
  ogImageUrl: string;
  discoverable: boolean;
}

/** A page route that records its page fields next to today's hand-built values. */
function proseRoute(collection: string, prefix: string): string {
  const docs = collection === "docs";
  const helpers = docs
    ? "getDocsStaticPaths as staticPaths, getDocsPage as resolvePage"
    : "getCollectionStaticPaths, getCollectionPage as resolvePage";
  return `---
import { entryRouteKey, ${helpers} } from ${runtime};
export const prerender = true;
export const getStaticPaths = ${docs ? "staticPaths" : `getCollectionStaticPaths(${JSON.stringify(collection)})`};
const page = await resolvePage(Astro);
if (page instanceof Response) return page;
const { entry, markdownUrl, sourceUrl, ogImageUrl } = page;
const routeKey = entryRouteKey(entry.id);
const record = {
  collection: entry.collection,
  id: entry.id,
  page: { markdownUrl, sourceUrl, ogImageUrl },
  hand: {
    markdownUrl: routeKey ? \`${prefix}/\${routeKey}/index.md\` : "${prefix}/index.md",
    sourceUrl: routeKey ? \`${prefix}/\${routeKey}/index.mdx\` : "${prefix}/index.mdx",
    ogImageUrl: \`/og${prefix}/\${entry.id}.png\`,
  },
};
---
<script type="application/json" data-page set:html={JSON.stringify(record)} />
`;
}

const API_ROUTE = `---
import { getApiRoute, getApiStaticPaths } from ${runtime};
export const prerender = true;
export const getStaticPaths = getApiStaticPaths("api");
const result = await getApiRoute(Astro);
if (result instanceof Response) return result;
const record = { href: result.page.href, socialImage: \`/og\${result.page.href.replace(/\\/$/, "")}.png\` };
---
<script type="application/json" data-api set:html={JSON.stringify(record)} />
`;

const INDEX_ROUTE = `import { getIndexedEntries, getOgImagePages, isDiscoverable } from ${runtime};
export const prerender = true;
export async function GET() {
  const indexed = (await getIndexedEntries()).map((item) => ({
    collection: item.collection,
    id: item.entry.id,
    url: item.url,
    markdownUrl: item.markdownUrl,
    sourceUrl: item.sourceUrl,
    ogImageUrl: item.ogImageUrl,
    discoverable: isDiscoverable(item.entry),
  }));
  const pages = Object.entries(await getOgImagePages()).map(([key, item]) => [key, item.ogImageUrl]);
  return new Response(JSON.stringify({ indexed, pages }));
}
`;

/** The starter's `og/[...slug].ts` keys before this change. */
function todaysOgKeys(indexed: readonly IndexedRecord[]): string[] {
  return indexed
    .filter((entry) => entry.discoverable)
    .map((entry) => {
      const routeId = entry.id.replace(/(?:^|\/)index$/, "");
      const pathname = entry.url.replace(/\/$/, "");
      const prefix = routeId ? pathname.slice(0, -routeId.length) : pathname;
      return `${prefix.replace(/\/$/, "")}/${entry.id}`.replace(/^\/+|\/+$/g, "");
    });
}

async function htmlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

async function records<T>(root: string, attribute: string): Promise<T[]> {
  const found: T[] = [];
  for (const file of await htmlFiles(path.join(root, "dist"))) {
    const match = new RegExp(`<script type="application/json" ${attribute}>(.*?)</script>`).exec(
      await readFile(file, "utf8"),
    );
    if (match) found.push(JSON.parse(match[1]!) as T);
  }
  return found;
}

test("page fields match today's hand-built URLs and the files the OG route writes", async () => {
  const site = await sites.buildSite(
    {
      "src/content.config.ts": `import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { apiCollection, docsCollection } from ${srcModule("content.ts")};
export const collections = {
  docs: defineCollection(docsCollection({ schemaFields: { slug: z.string().optional() } })),
  "docs-v1": defineCollection(docsCollection({ base: "docs-v1" })),
  "docs-v1.2": defineCollection(docsCollection({ base: "docs-v1.2" })),
  blog: defineCollection(docsCollection({ base: "blog" })),
  changelog: defineCollection(
    docsCollection({ base: "changelog", schemaFields: { date: z.coerce.date() } }),
  ),
  api: defineCollection(apiCollection()),
};`,
      "src/content/docs/index.mdx": "---\ntitle: Home\n---\nHome.\n",
      "src/content/docs/guide.mdx": "---\ntitle: Guide\n---\nGuide.\n",
      "src/content/docs/dotted.mdx":
        "---\ntitle: Encryption\nslug: 1.1.1.1/encryption\n---\nDotted.\n",
      "src/content/docs/nested.mdx": "---\ntitle: Section\nslug: section/index\n---\nNested.\n",
      "src/content/docs/hidden.mdx": "---\ntitle: Hidden\nnoindex: true\n---\nHidden.\n",
      "src/content/docs-v1/index.mdx": "---\ntitle: V1 home\n---\nV1.\n",
      "src/content/docs-v1/guide.mdx": "---\ntitle: V1 guide\n---\nV1 guide.\n",
      "src/content/docs-v1.2/index.mdx": "---\ntitle: V1.2 home\n---\nV1.2.\n",
      "src/content/docs-v1.2/guide.mdx": "---\ntitle: V1.2 guide\n---\nV1.2 guide.\n",
      "src/content/blog/index.mdx": "---\ntitle: Blog\n---\nBlog.\n",
      "src/content/blog/post.mdx": "---\ntitle: Post\n---\nPost.\n",
      "src/content/changelog/2026-01-01-first.mdx":
        "---\ntitle: First\ndate: 2026-01-01\n---\nFirst.\n",
      "src/pages/[...slug].astro": proseRoute("docs", ""),
      "src/pages/v1/[...slug].astro": proseRoute("docs-v1", "/v1"),
      "src/pages/v1.2/[...slug].astro": proseRoute("docs-v1.2", "/v1.2"),
      "src/pages/blog/[...slug].astro": proseRoute("blog", "/blog"),
      "src/pages/changelog/[...slug].astro": proseRoute("changelog", "/changelog"),
      "src/pages/api/[...slug].astro": API_ROUTE,
      "src/pages/urls.json.ts": INDEX_ROUTE,
      "src/pages/[...slug]/index.md.ts": `import { markdownRoute } from ${srcModule("agent-endpoints.ts")};
export const prerender = true;
export const { GET, getStaticPaths } = markdownRoute();
`,
    },
    {
      versions: { current: "v2", others: ["v1", "v1.2"] },
      api: [{ collection: "api", spec: SMALLCO_SPEC }],
    },
  );

  const pages = await records<PageRecord>(site.root, "data-page");
  const { indexed, pages: ogPages } = JSON.parse(
    await readFile(path.join(site.root, "dist/urls.json"), "utf8"),
  ) as { indexed: IndexedRecord[]; pages: Array<[string, string]> };
  const prose = indexed.filter((item) => item.collection !== "api");
  assert.equal(pages.length, prose.length);
  assert.equal(pages.length, 12);

  const baked = new Set((await agentManifest(site.root)).markdownAssets.map((asset) => asset.url));
  const ogKeys = new Map(ogPages.map(([key, url]) => [url, key]));
  const changed: string[] = [];
  for (const record of pages) {
    const item = indexed.find(
      (candidate) => candidate.collection === record.collection && candidate.id === record.id,
    );
    assert.ok(item, `${record.collection}:${record.id} is indexed`);
    assert.deepEqual(
      record.page,
      { markdownUrl: item.markdownUrl, sourceUrl: item.sourceUrl, ogImageUrl: item.ogImageUrl },
      `${record.collection}:${record.id} page fields equal IndexedEntry`,
    );
    assert.equal(record.page.markdownUrl, record.hand.markdownUrl);
    assert.equal(record.page.sourceUrl, record.hand.sourceUrl);
    assert.ok(baked.has(record.page.markdownUrl), `${record.page.markdownUrl} is baked`);
    assert.ok(baked.has(record.page.sourceUrl!), `${record.page.sourceUrl} is baked`);
    assert.equal(ogKeys.get(record.page.ogImageUrl), ogImagePageKey(record.page.ogImageUrl));
    if (record.page.ogImageUrl !== record.hand.ogImageUrl) {
      changed.push(`${record.hand.ogImageUrl} -> ${record.page.ogImageUrl}`);
    }
  }
  assert.deepEqual(changed.sort(), [
    "/og/blog/index.png -> /og/blog.png",
    "/og/section/index.png -> /og/section.png",
    "/og/v1.2/index.png -> /og/v1.2.png",
    "/og/v1/index.png -> /og/v1.png",
  ]);

  const api = await records<{ href: string; socialImage: string }>(site.root, "data-api");
  const apiUrls = new Set(
    indexed.filter((item) => item.collection === "api").map((item) => item.ogImageUrl),
  );
  assert.ok(api.length > 20);
  for (const { socialImage } of api) assert.ok(apiUrls.has(socialImage), socialImage);

  const urls = indexed.map((item) => item.ogImageUrl).sort();
  assert.deepEqual(ogPages.map(([, url]) => url).sort(), urls, "one card per indexed page");
  const written = await writtenOgImages(ogPages.map(([key]) => key));
  assert.deepEqual(written.sort(), urls, "every card lands at its ogImageUrl");

  const todays = await writtenOgImages(todaysOgKeys(indexed));
  const before = new Set(todays);
  const after = new Set(written);
  assert.equal(todays.length - before.size, 2, "today v1, v1.2, and v1.2/guide collide at /og/v1.png");
  assert.deepEqual(
    {
      removed: [...before].filter((url) => !after.has(url)).sort(),
      added: [...after].filter((url) => !before.has(url)).sort(),
    },
    {
      removed: ["/og/1.1.1.png", "/og/api/webhooks/payment.png"],
      added: [
        "/og/1.1.1.1/encryption.png",
        "/og/api/webhooks/payment.succeeded.png",
        "/og/hidden.png",
        "/og/v1.2.png",
        "/og/v1.2/guide.png",
      ],
    },
  );
});
