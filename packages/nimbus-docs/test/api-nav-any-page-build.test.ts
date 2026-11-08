// `getApiNav` end to end, through `astro build`: any route gets the API sidebar
// opened at an API page, the same nav that page's own route gets apart from its
// current row and previous/next links, in every store (thin entries, bundled
// entries, `bundle: false`), version mode and mount, without reading the page.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import { build, type AstroIntegration } from "astro";

import nimbus from "../src/index.ts";
import { runningNimbusVersion } from "../src/_internal/upgrades.ts";
import { buildApiModel, getApiNav, type ApiNav, type ApiNavItem } from "../src/api/index.js";
import { setLinkPolicy } from "../src/_internal/url.js";
import { TEST_TMP } from "./fixtures/temp-root.js";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const moduleUrl = (relative: string) =>
  JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, relative)).href);
const RUNTIME = moduleUrl("../src/runtime.ts");
const SRC = path.resolve(import.meta.dirname, "../src");
const SPEC = path.resolve(import.meta.dirname, "fixtures/api/smallco.yaml");
const BASE = "/docs";

// v1 groups its tags into x-tagGroups categories, which have no page of their
// own: the overview lists their rows.
const ok = { "200": { description: "ok" } };
const GROUPED = {
  openapi: "3.1.0",
  info: { title: "Grouped", version: "1" },
  "x-tagGroups": [
    { name: "Compute", tags: ["Workers", "KV"] },
    { name: "Network", tags: ["DNS"] },
  ],
  tags: [{ name: "Workers" }, { name: "KV" }, { name: "DNS" }, { name: "Loose" }],
  paths: {
    "/workers": { get: { operationId: "workersList", summary: "List Workers", tags: ["Workers"], responses: ok } },
    "/kv": { get: { operationId: "kvList", summary: "List namespaces", tags: ["KV"], responses: ok } },
    "/dns": { get: { operationId: "dnsList", summary: "List records", tags: ["DNS"], responses: ok } },
    "/loose": { get: { operationId: "looseGet", summary: "Get loose", tags: ["Loose"], responses: ok } },
  },
};

// The page projection is counted wherever it's registered: the registry lives
// on globalThis, so the build's own module instance registers into this one.
const PROJECTOR_STATE = Symbol.for("@cloudflare/nimbus-docs/api-projector/v1");
const projections = { page: 0, nav: 0 };
type Projectors = Record<"page" | "pageProps" | "nav", (...args: unknown[]) => unknown>;
let registered: Projectors | undefined;
(globalThis as Record<symbol, unknown>)[PROJECTOR_STATE] = {
  version: 1,
  get projectors() {
    return registered;
  },
  set projectors(value: Projectors) {
    registered = {
      ...value,
      page: (...args) => (projections.page++, value.page(...args)),
      nav: (...args) => (projections.nav++, value.nav(...args)),
    };
  },
};
(globalThis as Record<string, unknown>).__nimbusTestProjections = projections;

// Request rendering needs a known adapter; this stand-in takes its name and
// serves Astro's generated App directly. Under the Node adapter's name, page
// assets are read from disk rather than through a Workers binding.
function testAdapter(entrypoint: string, name: string): AstroIntegration {
  return {
    name,
    hooks: {
      "astro:config:done": ({ setAdapter }) => {
        setAdapter({
          name,
          entrypointResolution: "auto",
          serverEntrypoint: entrypoint,
          supportedAstroFeatures: { serverOutput: "stable" },
        });
      },
    },
  };
}

// Route files import the runtime by its package name: that's how Nimbus reads
// which collection a route serves, and where it's mounted.
const navPage = (prerender: boolean, collection?: string) => `---
import { getApiRoute${prerender ? ", getApiStaticPaths" : ""} } from "@cloudflare/nimbus-docs/runtime";
export const prerender = ${prerender};
${prerender ? `export const getStaticPaths = getApiStaticPaths("api");` : ""}
const result = await getApiRoute(Astro${collection ? `, ${JSON.stringify(collection)}` : ""});
if (result instanceof Response) return result;
---
<nav-json set:html={JSON.stringify({ nav: result.nav, version: result.version }).replaceAll("<", "\\\\u003c")}></nav-json>`;

// A page that isn't an API page asks for the nav at each href, and reports how
// many page projections the calls made.
const probePage = (prerender: boolean, calls: Array<{ collection: string; href: string }>) => `---
import { getApiNav } from ${RUNTIME};
export const prerender = ${prerender};
const counts = globalThis.__nimbusTestProjections;
const before = counts ? { ...counts } : undefined;
const results = [];
// An error comes back as its message, so a failing call names itself.
for (const call of ${JSON.stringify(calls)}) results.push(await getApiNav(Astro, call).catch((error) => ({ error: String(error?.stack ?? error) })));
const projected = counts && before ? { page: counts.page - before.page, nav: counts.nav - before.nav } : null;
---
<probe-json set:html={JSON.stringify({ results, projected }).replaceAll("<", "\\\\u003c")}></probe-json>`;

interface Site {
  root: string;
  get(pathname: string): Promise<{ status: number; body: string }>;
}

async function buildSite(options: {
  request: boolean;
  api: Record<string, unknown>;
  base: string;
  pages: Record<string, string>;
  /** The adapter request rendering runs under: Cloudflare unless named. */
  adapter?: string;
  /** Leave out the docs collection: the API alone, as when it's served at `/`. */
  apiOnly?: boolean;
  /** Run before the server answers its first request. */
  beforeServe?: (root: string) => Promise<void>;
}): Promise<Site> {
  const root = await mkdtemp(path.join(TEST_TMP, "nimbus-api-nav-any-page-"));
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
  ${options.apiOnly ? "" : "docs: defineCollection(docsCollection()),"}
  api: defineCollection(apiCollection(${JSON.stringify(options.api)})),
};`,
  );
  if (options.api.bundle === false)
    await write(
      "src/live.config.ts",
      `import { defineLiveCollection } from "astro:content";
import { apiPagesLoader } from "@cloudflare/nimbus-docs/live";
export const collections = { apiPages: defineLiveCollection({ loader: apiPagesLoader() }) };`,
    );
  if (!options.apiOnly) await write("src/content/docs/guide.md", "---\ntitle: Guide\n---\n\nText.\n");
  for (const [file, contents] of Object.entries(options.pages)) await write(file, contents);
  let adapter: AstroIntegration | undefined;
  if (options.request) {
    await write("server-entry.mjs", `import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n`);
    adapter = testAdapter(path.join(root, "server-entry.mjs"), options.adapter ?? "@astrojs/cloudflare");
  }
  await build({
    root: pathToFileURL(`${root}${path.sep}`),
    cacheDir: path.join(root, ".astro"),
    outDir: "./dist",
    build: { server: path.join(root, ".server"), client: path.join(root, "dist") },
    vite: {
      cacheDir: path.join(root, ".vite"),
      resolve: {
        alias: [
          { find: /^@cloudflare\/nimbus-docs$/, replacement: path.join(SRC, "index.ts") },
          { find: /^@cloudflare\/nimbus-docs\//, replacement: `${SRC}/` },
        ],
      },
    },
    base: options.base,
    ...(adapter ? { output: "server" as const, adapter } : {}),
    logLevel: "silent",
    integrations: [
      nimbus(
        {
          site: "https://example.test",
          title: "Test",
          description: "Test",
          search: false,
          api: [options.api as never],
          ...(options.request ? { rendering: { default: "build", collections: { api: "request" } } } : {}),
        },
        { admonitions: false, sitemap: false, validateMdx: false },
      ),
    ],
  });
  await options.beforeServe?.(root);
  const prefix = options.base.replace(/\/$/, "");

  if (!options.request) {
    return {
      root,
      async get(pathname) {
        const file = path.join(root, "dist", pathname.slice(prefix.length), "index.html");
        try {
          return { status: 200, body: await readFile(file, "utf8") };
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
    root,
    async get(pathname) {
      const response = await app.render(new Request(`https://example.test${pathname}`, { redirect: "manual" }));
      return { status: response.status, body: await response.text() };
    },
  };
}

function jsonOf<T>(tag: string, html: string): T {
  const json = new RegExp(`<${tag}>([\\s\\S]*)</${tag}>`).exec(html)?.[1];
  assert.ok(json, `page renders <${tag}>`);
  return JSON.parse(json) as T;
}

const flatten = (items: ApiNavItem[]): ApiNavItem[] => items.flatMap((item) => [item, ...flatten(item.children)]);
const find = (items: ApiNavItem[], coordinate: string) => flatten(items).find((i) => i.coordinate === coordinate);

// What a route's nav becomes for a page that isn't that API page: its trail
// open, nothing current, no previous/next links.
function opened(nav: ApiNav): ApiNav {
  const open = (item: ApiNavItem): ApiNavItem => {
    if (!item.active && !item.expanded) return item;
    const { active: _active, ...rest } = item;
    return { ...rest, expanded: true, children: item.children.map(open) };
  };
  const { prevNext: _prevNext, ...rest } = nav;
  return { ...rest, items: nav.items.map(open) };
}

type ProbeResult = { nav: ApiNav; version: string | null } | null;
type Probe = { results: ProbeResult[]; projected: { page: number; nav: number } | null };

let groupedSpec = "";
// Hrefs from each version's own nav: a section with rows, and an operation in it.
let v2: { section: ApiNavItem; operation: ApiNavItem };
let v1: { section: ApiNavItem; pageless: ApiNavItem };
before(async () => {
  setLinkPolicy({ trailingSlash: "ignore", format: "directory" });
  const dir = await mkdtemp(path.join(TEST_TMP, "nimbus-api-nav-grouped-"));
  roots.push(dir);
  groupedSpec = path.join(dir, "grouped.json");
  await writeFile(groupedSpec, JSON.stringify(GROUPED));
  const latest = getApiNav(await buildApiModel({ collection: "api", spec: await readFile(SPEC, "utf8"), mountPath: "/api" }));
  const section = latest.items.find((i) => i.href && i.children.some((c) => c.href))!;
  v2 = { section, operation: section.children.find((c) => c.href)! };
  const grouped = getApiNav(await buildApiModel({ collection: "api", spec: JSON.stringify(GROUPED), mountPath: "/api/v1" }));
  v1 = {
    pageless: grouped.items.find((i) => !i.href && i.children.length > 0)!,
    section: flatten(grouped.items).find((i) => i.href && i.children.length > 0)!,
  };
  assert.ok(v2.section && v2.operation && v1.pageless && v1.section, "the fixtures have the shapes these tests need");
});

for (const request of [false, true]) {
  describe(`bundled API, path versions, ${request ? "request-rendered (prepared entries)" : "prerendered (thin entries)"}`, () => {
    let site: Site;
    let hrefs: string[];
    let probe: Probe;
    before(async () => {
      hrefs = [
        "/api/",
        v2.section.href!,
        v2.operation.href!,
        "/api/v1/",
        v1.section.href!,
        "/api", // no trailing slash
        "/apiary/", // outside the family path
        "/api/nope/",
        "/api/index/999999/", // a home part: no nav href names one
      ];
      const calls = [
        ...hrefs.map((href) => ({ collection: "api", href })),
        { collection: "nope", href: "/api/" },
        { collection: "api", href: "http://[" },
      ];
      site = await buildSite({
        request,
        base: BASE,
        api: {
          collection: "api",
          sidebar: "on-demand",
          versions: [
            { version: "v2", default: true, spec: SPEC },
            { version: "v1", spec: groupedSpec },
          ],
        },
        pages: {
          "src/pages/api/[...slug].astro": navPage(!request),
          "src/pages/probe.astro": probePage(!request, calls),
          "src/pages/[...slug].astro": `---\nimport { getDocsStaticPaths } from ${RUNTIME};\nexport const prerender = true;\nexport const getStaticPaths = getDocsStaticPaths;\n---\n<p>doc</p>`,
        },
      });
      const { status, body } = await site.get(`${BASE}/probe/`);
      assert.equal(status, 200);
      probe = jsonOf<Probe>("probe-json", body);
    });

    const routeNav = async (href: string) => {
      const { status, body } = await site.get(`${BASE}${href}`);
      assert.equal(status, 200, href);
      return jsonOf<{ nav: ApiNav; version: string | null }>("nav-json", body);
    };

    test("each href gets its own route's nav, open at the page with nothing current", async () => {
      for (const [i, href] of hrefs.slice(0, 5).entries()) {
        const result = probe.results[i];
        assert.ok(result, href);
        const route = await routeNav(href);
        assert.equal(result.version, route.version, `${href}: version`);
        assert.deepEqual(result.nav, opened(route.nav), `${href}: nav`);
        assert.ok(result.nav.listHref, `${href}: the sidebar filter's list`);
        assert.equal(result.nav.listHref, route.nav.listHref);
        assert.equal(flatten(result.nav.items).some((item) => item.active), false, `${href}: nothing current`);
        assert.equal(result.nav.prevNext, undefined, `${href}: no previous/next`);
      }
    });

    test("a section opens with its rows; path versions resolve under the family path", () => {
      const [overview, section, operation, v1Overview, v1Section] = probe.results;
      assert.equal(overview!.version, "v2");
      const open = find(section!.nav.items, v2.section.coordinate)!;
      assert.equal(open.expanded, true);
      assert.ok(open.children.length > 0 && !open.deferred, "its rows are listed");
      assert.equal(find(operation!.nav.items, v2.operation.coordinate)!.expanded, true);
      assert.equal(v1Overview!.version, "v1", "/api/v1/ is the v1 overview, not a v2 page");
      assert.equal(v1Section!.version, "v1");
      assert.equal(find(v1Section!.nav.items, v1.section.coordinate)!.expanded, true);
    });

    test("the overview lists a page-less group's rows, as the overview's own route does", async () => {
      const [, , , v1Overview] = probe.results;
      const group = find(v1Overview!.nav.items, v1.pageless.coordinate)!;
      const route = find((await routeNav("/api/v1/")).nav.items, v1.pageless.coordinate)!;
      assert.ok(group.children.length > 0);
      assert.deepEqual(group.children, route.children);
    });

    test("an href without a trailing slash still names the overview", async () => {
      assert.deepEqual(probe.results[5], probe.results[0]);
    });

    test("null for anything the href doesn't name", () => {
      const [, , , , , , outside, missing, homePart, unknownCollection, invalid] = probe.results;
      assert.equal(outside, null, "outside the family path");
      assert.equal(missing, null, "unknown page");
      assert.equal(homePart, null, "a home part");
      assert.equal(unknownCollection, null, "unknown collection");
      assert.equal(invalid, null, "not a URL");
    });

    if (!request) {
      test("thin entries project only navigation, never a page", () => {
        assert.ok(probe.projected, "the projection counter is installed");
        assert.equal(probe.projected.page, 0);
        assert.ok(probe.projected.nav > 0);
      });
    }
  });
}

describe("bundle: false, query versions, served at the site root, on request", () => {
  let site: Site;
  let probe: Probe;
  let hrefs: string[];
  let held: { from: string; to: string }[] = [];
  before(async () => {
    const section = v2.section.href!.replace(/^\/api/, "");
    hrefs = ["/", "/?version=v1", `${section}?version=v1`, section, "/?api-version=v1", "/nope/"];
    site = await buildSite({
      request: true,
      base: "/",
      apiOnly: true,
      adapter: "@astrojs/node",
      api: {
        collection: "api",
        versionUrl: { in: "query" },
        bundle: false,
        sidebar: "on-demand",
        versions: [
          { version: "v2", default: true, spec: SPEC },
          { version: "v1", spec: SPEC },
        ],
      },
      pages: {
        "src/pages/[...slug].astro": navPage(false, "api"),
        "src/pages/probe.astro": probePage(false, hrefs.map((href) => ({ collection: "api", href }))),
      },
      // Every page record is held aside while the probe runs: what answers it
      // read only the version's index.
      async beforeServe(root) {
        const aside = path.join(root, "held-records");
        await mkdir(aside);
        const records = (await readdir(root, { recursive: true })).filter(
          // Records are written alone or packed together.
          (name) => /^(record|pack)-[0-9a-f]+\.json$/.test(path.basename(name)) && !name.startsWith("held-records"),
        );
        held = records.map((name, i) => ({ from: path.join(root, name), to: path.join(aside, `${i}-${path.basename(name)}`) }));
        await Promise.all(held.map(({ from, to }) => rename(from, to)));
      },
    });
    assert.ok(held.length > 0, "the build wrote page records");
    const { status, body } = await site.get("/probe/");
    assert.equal(status, 200, "the probe page renders");
    probe = jsonOf<Probe>("probe-json", body);
    // The overview's own route needs its record, which is held aside.
    assert.notEqual((await site.get("/")).status, 200, "a page route reads its record");
    await Promise.all(held.map(({ from, to }) => rename(to, from)));
  });

  test("answers from the index alone, and matches each page's own route", async () => {
    for (const [i, href] of hrefs.slice(0, 4).entries()) {
      const result = probe.results[i];
      assert.ok(result, href);
      const { status, body } = await site.get(href);
      assert.equal(status, 200, href);
      const route = jsonOf<{ nav: ApiNav; version: string | null }>("nav-json", body);
      assert.equal(result.version, route.version, `${href}: version`);
      assert.deepEqual(result.nav, opened(route.nav), `${href}: nav`);
      assert.ok(result.nav.listHref, `${href}: the sidebar filter's list`);
    }
    const [, v1Overview, v1Section, v2Section] = probe.results;
    assert.equal(v1Overview!.version, "v1", "?version= selects the version");
    assert.equal(find(v1Section!.nav.items, v2.section.coordinate)!.expanded, true);
    assert.equal(v2Section!.version, "v2");
  });

  test("an href that redirects, or names nothing, is null", () => {
    const [, , , , legacy, missing] = probe.results;
    assert.equal(legacy, null, "the legacy version parameter redirects");
    assert.equal(missing, null);
  });
});

describe("an API mounted at a non-ASCII path", () => {
  let probe: Probe;
  before(async () => {
    const site = await buildSite({
      request: false,
      base: "/",
      api: { collection: "api", spec: SPEC },
      pages: {
        "src/pages/référence/[...slug].astro": navPage(true),
        "src/pages/probe.astro": probePage(true, [
          { collection: "api", href: "/référence/" },
          { collection: "api", href: "/r%C3%A9f%C3%A9rence/" },
          { collection: "api", href: v2.section.href!.replace(/^\/api/, "/référence") },
          { collection: "api", href: "/api/" },
        ]),
        "src/pages/[...slug].astro": `---\nimport { getDocsStaticPaths } from ${RUNTIME};\nexport const prerender = true;\nexport const getStaticPaths = getDocsStaticPaths;\n---\n<p>doc</p>`,
      },
    });
    const { status, body } = await site.get("/probe/");
    assert.equal(status, 200, "the probe page renders");
    probe = jsonOf<Probe>("probe-json", body);
  });

  test("its hrefs resolve, written as the nav writes them or percent-encoded", () => {
    const [raw, encoded, section, oldMount] = probe.results;
    assert.ok(raw, "the nav's own href");
    assert.deepEqual(encoded, raw);
    assert.equal(find(section!.nav.items, v2.section.coordinate)!.expanded, true);
    assert.equal(oldMount, null, "the default mount isn't this API's");
  });
});
