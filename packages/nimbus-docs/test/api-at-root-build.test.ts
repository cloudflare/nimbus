// An API reference as the whole site: its route at `src/pages/[...slug].astro`
// serves it at `/`, with no `docs` collection. Every URL Nimbus builds for it
// is root-relative, built and on request, with path and query versions, with
// and without Astro's `base`. The fixture renders links as a component does,
// through `withBase`, and the tests follow them as a browser would.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import type { ApiNav, ApiNavItem } from "../src/api/index.js";
import { agentSites, siteApp, srcModule, type AgentSite } from "./fixtures/agent-site.ts";
import { TEST_TMP } from "./fixtures/temp-root.js";

const sites = agentSites();
after(() => sites.cleanup());

const runtime = JSON.stringify("@cloudflare/nimbus-docs/runtime");
const endpoints = JSON.stringify("@cloudflare/nimbus-docs/agent-endpoints");

// Tags grouped into x-tagGroups categories, which have no page of their own:
// a collapsed category's rows load from the version's home.
const ok = { "200": { description: "ok" } };
const spec = (title: string) => ({
  openapi: "3.1.0",
  info: { title, version: "1" },
  "x-tagGroups": [
    { name: "Compute", tags: ["Workers", "KV"] },
    { name: "Network", tags: ["DNS"] },
  ],
  tags: [{ name: "Workers" }, { name: "KV" }, { name: "DNS" }],
  paths: {
    "/workers": { get: { operationId: "workersList", summary: "List Workers", tags: ["Workers"], responses: ok } },
    "/kv": { get: { operationId: "kvList", summary: "List namespaces", tags: ["KV"], responses: ok } },
    "/dns": { get: { operationId: "dnsList", summary: "List records", tags: ["DNS"], responses: ok } },
  },
});

const route = (request: boolean) => `---
import { getApiRoute, getApiStaticPaths, getApiVersions, withBase } from ${runtime};
${request ? "" : `export const getStaticPaths = getApiStaticPaths("api", { homeChunkSize: 2 });`}
const result = await getApiRoute(Astro, "api", { homeChunkSize: 2 });
if (result instanceof Response) return result;
const { page, nav, version, home } = result;
const versions = (await getApiVersions("api")) ?? [];
const based = (href) => withBase(href, import.meta.env.BASE_URL);
const browserNav = (items) => items.map((item) => ({ ...item, href: item.href && based(item.href), childrenHref: item.childrenHref && based(item.childrenHref), children: browserNav(item.children) }));
---
<html><body><main data-version={version ?? ""} data-kind={page.kind}>
<a class="self" href={based(page.href)}>self</a>
{page.markdownHref ? <a class="md" href={based(page.markdownHref)}>md</a> : null}
{page.breadcrumbs.map((crumb) => (crumb.href ? <a class="crumb" href={based(crumb.href)}>crumb</a> : null))}
{versions.map((v) => <a class="picker" href={based(v.url)}>{v.version}</a>)}
{(home?.parts ?? []).map((part) => <a class="part" href={based(part.href)}>part</a>)}
<nav-json set:html={JSON.stringify({ ...nav, items: browserNav(nav.items) }).replaceAll("<", "\\\\u003c")}></nav-json>
</main></body></html>
`;

interface Variant {
  name: string;
  request: boolean;
  versionUrl: "path" | "query";
  base: "/" | "/docs";
}

const VARIANTS: Variant[] = [
  { name: "built, path versions", request: false, versionUrl: "path", base: "/" },
  { name: "built, path versions, base /docs", request: false, versionUrl: "path", base: "/docs" },
  { name: "on request, path versions", request: true, versionUrl: "path", base: "/" },
  { name: "on request, query versions", request: true, versionUrl: "query", base: "/" },
  { name: "on request, query versions, base /docs", request: true, versionUrl: "query", base: "/docs" },
];

let specDir = "";
before(async () => {
  specDir = await mkdtemp(path.join(TEST_TMP, "nimbus-api-root-specs-"));
  await writeFile(path.join(specDir, "v2.json"), JSON.stringify(spec("Pets v2")));
  await writeFile(path.join(specDir, "v1.json"), JSON.stringify(spec("Pets v1")));
});

async function buildRootApi(variant: Variant): Promise<AgentSite> {
  return sites.buildSite(
    {
      "src/content.config.ts": `import { defineCollection } from "astro:content";
import { apiCollection } from ${srcModule("content.ts")};
export const collections = { api: defineCollection(apiCollection()) };`,
      "src/pages/[...slug].astro": route(variant.request),
      // The root agent routes follow the root collection's mode. On request they
      // load the Cloudflare runtime, so they're fetched only from built variants;
      // a real adapter covers them on request.
      "src/pages/[...slug]/index.md.ts": `import { markdownRoute } from ${endpoints};\nexport const { GET${variant.request ? "" : ", getStaticPaths"} } = markdownRoute();\n`,
      "src/pages/llms.txt.ts": `import { llmsRoute } from ${endpoints};\n${variant.request ? "export const prerender = true;\n" : ""}export const { GET } = llmsRoute();\n`,
      ...(variant.request
        ? {}
        : { "src/pages/[...section]/llms.txt.ts": `import { llmsSectionRoute } from ${endpoints};\nexport const { GET, getStaticPaths } = llmsSectionRoute();\n` }),
    },
    {
      packageImports: true,
      logLevel: "warn",
      sitemap: true,
      base: variant.base,
      server: variant.request,
      adapterName: "@astrojs/cloudflare",
      ...(variant.request ? { rendering: { default: "build", collections: { api: "request" } } } : {}),
      api: [
        {
          collection: "api",
          sidebar: "on-demand",
          ...(variant.versionUrl === "query" ? { versionUrl: { in: "query" } } : {}),
          versions: [
            { version: "v2", spec: path.join(specDir, "v2.json"), default: true },
            { version: "v1", spec: path.join(specDir, "v1.json") },
          ],
        },
      ],
    },
  );
}

/** Fetches a browser URL, `base` included. */
type Get = (url: string) => Promise<{ status: number; body: string }>;

async function fetcher(site: AgentSite, variant: Variant): Promise<Get> {
  if (variant.request) {
    const app = await siteApp(site);
    return async (url) => {
      const response = await app.render(new Request(`https://example.test${url}`));
      return { status: response.status, body: await response.text() };
    };
  }
  // A static host serves `dist/` at `base`.
  const prefix = variant.base === "/" ? "" : variant.base;
  return async (url) => {
    const [pathname] = url.split("?");
    if (!pathname!.startsWith(`${prefix}/`)) return { status: 404, body: "" };
    const clean = pathname!.slice(prefix.length);
    const file = path.join(site.root, "dist", /\.[a-z]+$/.test(clean) ? clean : path.join(clean, "index.html"));
    return existsSync(file) ? { status: 200, body: await readFile(file, "utf8") } : { status: 404, body: "" };
  };
}

const hrefs = (html: string, cls: string) =>
  [...html.matchAll(new RegExp(`<a class="${cls}" href="([^"]*)"`, "g"))].map((m) => m[1]!);
const navOf = (html: string) =>
  JSON.parse(/<nav-json>([\s\S]*?)<\/nav-json>/.exec(html)![1]!) as ApiNav;
const flatten = (items: ApiNavItem[]): ApiNavItem[] => items.flatMap((item) => [item, ...flatten(item.children)]);

const OP = "/Workers/workersList/";

/** The browser URL of a page of the default or old version, by the variant's version URLs and base. */
function at(variant: Variant, slug: string, old: boolean): string {
  const prefix = variant.base === "/" ? "" : variant.base;
  if (!old) return `${prefix}${slug}`;
  return variant.versionUrl === "path" ? `${prefix}/v1${slug}` : `${prefix}${slug}?version=v1`;
}

for (const variant of VARIANTS) {
  describe(`API at the root, ${variant.name}`, () => {
    const prefix = variant.base === "/" ? "" : variant.base;
    let site: AgentSite;
    let get: Get;
    before(async () => {
      site = await buildRootApi(variant);
      get = await fetcher(site, variant);
    });

    test("serves both versions' pages at root URLs, with root-relative links", async () => {
      for (const old of [false, true]) {
        for (const slug of ["/", OP, "/tags/Workers/", "/index/2/"]) {
          const url = at(variant, slug, old);
          const { status, body } = await get(url);
          assert.equal(status, 200, url);
          assert.match(body, new RegExp(`data-version="${old ? "v1" : "v2"}"`), url);
          const nav = navOf(body);
          const links = [
            ...["self", "md", "crumb", "picker", "part"].flatMap((cls) => hrefs(body, cls)),
            ...flatten(nav.items).flatMap((item) => [item.href, item.childrenHref].filter((h): h is string => h !== undefined)),
          ];
          for (const href of links) {
            assert.ok(href.startsWith(`${prefix}/`) && !href.startsWith("//") && !href.startsWith(`${prefix}/api/`), `${url}: ${JSON.stringify(href)}`);
          }
          assert.doesNotMatch(body, /<a class="(?:self|md|crumb|picker|part)" href>/, `${url}: an empty href`);
        }
      }
    });

    test("links each page to itself, its Markdown and the picker's versions", async () => {
      const home = (await get(at(variant, "/", false))).body;
      assert.deepEqual(hrefs(home, "self"), [at(variant, "/", false)]);
      assert.deepEqual(hrefs(home, "md"), [at(variant, "/index.md", false)]);
      assert.deepEqual(hrefs(home, "picker"), [at(variant, "/", false), at(variant, "/", true)]);
      assert.deepEqual(hrefs(home, "part"), [at(variant, "/", false), at(variant, "/index/2/", false)]);
      for (const href of [...hrefs(home, "part"), ...hrefs(home, "picker")]) assert.equal((await get(href)).status, 200, href);
      const op = (await get(at(variant, OP, true))).body;
      assert.deepEqual(hrefs(op, "self"), [at(variant, OP, true)]);
      assert.deepEqual(hrefs(op, "crumb"), [at(variant, "/", true), at(variant, "/tags/Workers/", true)]);
      assert.deepEqual(hrefs(op, "md"), variant.versionUrl === "path" ? [at(variant, `/v1${OP}index.md`, false)] : []);
    });

    test("an on-demand sidebar loads a page-less category's rows from its version's home", async () => {
      for (const old of [false, true]) {
        const nav = navOf((await get(at(variant, OP, old))).body);
        const category = flatten(nav.items).find((item) => item.deferred && item.href === undefined);
        assert.ok(category, "a collapsed category");
        const home = at(variant, "/", old);
        assert.equal(category.childrenHref, home);
        const there = flatten(navOf((await get(category.childrenHref!)).body).items).find((item) => item.coordinate === category.coordinate);
        assert.ok(there && !there.deferred && there.children.length > 0, `${home} lists ${category.coordinate} open`);
      }
    });

    test("never queries a docs collection the site doesn't have", () => {
      assert.doesNotMatch(site.logs, /collection "docs"/);
    });

    if (variant.request) {
      test("returns 404 for pages no version has", async () => {
        assert.equal((await get(at(variant, "/nope/", false))).status, 404);
        if (variant.versionUrl === "query") {
          assert.equal((await get(at(variant, `/v1${OP}`, false))).status, 404, "version-prefixed paths aren't routes in query mode");
        }
      });
    } else {
      test("publishes agent files, specs and the sitemap at root URLs", async () => {
        const origin = `https://example.test${prefix}`;
        const sitemap = (await get(`${prefix}/sitemap-0.xml`)).body;
        const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]!);
        assert.ok(locs.includes(`${origin}/`) && locs.includes(`${origin}${OP}`) && locs.includes(`${origin}/v1${OP}`), locs.join("\n"));
        assert.ok(locs.every((loc) => loc.startsWith(`${origin}/`) && !loc.includes("/api/") && !loc.includes("/index/2")), locs.join("\n"));
        const llms = (await get(`${prefix}/llms.txt`)).body;
        assert.match(llms, new RegExp(`\\(${origin}/index\\.md\\)`));
        // Operations are listed in their tag's index, as the sidebar groups them.
        assert.match(llms, new RegExp(`\\(${origin}/tags/llms\\.txt\\)`));
        assert.match((await get(`${prefix}/tags/llms.txt`)).body, new RegExp(`\\(${origin}/tags/Workers/llms\\.txt\\)`));
        assert.match((await get(`${prefix}/tags/Workers/llms.txt`)).body, new RegExp(`\\(${origin}${OP}index\\.md\\)`));
        assert.equal((await get(`${prefix}/Workers/llms.txt`)).status, 404);
        assert.equal((await get(`${prefix}/index.md`)).status, 200);
        assert.equal((await get(`${prefix}${OP}index.md`)).status, 200);
        assert.equal((await get(`${prefix}/openapi.json`)).status, 200);
        assert.equal((await get(`${prefix}/v1/openapi.json`)).status, 200);
        const catalog = await readFile(path.join(site.root, "dist/.well-known/api-catalog"), "utf8");
        assert.match(catalog, new RegExp(`"href": "${origin}/openapi\\.json"`));
        assert.doesNotMatch(catalog, /\/api\//);
        const ard = await readFile(path.join(site.root, "dist/.well-known/ard.json"), "utf8");
        assert.match(ard, new RegExp(`${origin}/`));
        assert.doesNotMatch(ard, /\/api\//);
      });
    }
  });
}
