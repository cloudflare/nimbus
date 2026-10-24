// The `resource-action-v2` route convention: v1's operation derivation, byte
// for byte, plus tag pages at lowercase kebab-case URLs. Unit tests pin the
// tag projection, the v1/legacy freeze, operation parity, nav-only categories,
// tag collisions and the config error; one real build checks that every
// surface that writes a tag href agrees, under a non-`/api` mount and an Astro
// `base`, and that a family mixing v1 and v2 links each tag page to its
// counterpart in both path and query version modes.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build, type AstroIntegration } from "astro";

import { policyTagRouteSegment, tagRouteSegment } from "../src/_internal/api/coordinates.js";
import { routeSlugFault, type RoutePolicy } from "../src/_internal/api/route-policy.js";
import {
  buildApiModel,
  getApiNav,
  getApiPageSlugs,
  getApiRouteProvenance,
} from "../src/api/index.js";
import { validateNimbusConfig } from "../src/_internal/validate.js";
import nimbus from "../src/index.ts";
import { runningNimbusVersion } from "../src/_internal/upgrades.ts";
import { TEST_TMP } from "./fixtures/temp-root.js";

const V1: RoutePolicy = { convention: "resource-action-v1", stripPathPrefixes: ["/v1"] };
const V2: RoutePolicy = { convention: "resource-action-v2", stripPathPrefixes: ["/v1"] };

type PathItem = Record<string, unknown>;
const OK = { responses: { "200": { description: "ok" } } };
const ID_PARAM = { name: "id", in: "path", required: true, schema: { type: "string" } };

function spec(paths: Record<string, PathItem>, extra: Record<string, unknown> = {}) {
  return { openapi: "3.0.0", info: { title: "T", version: "1.0.0" }, paths, ...extra };
}

async function slugsOf(
  collection: string,
  paths: Record<string, PathItem>,
  routes: RoutePolicy | undefined,
  extra: Record<string, unknown> = {},
): Promise<Map<string, string>> {
  const model = await buildApiModel({ collection, spec: spec(paths, extra), routes });
  return new Map(getApiPageSlugs(model).map(({ coordinate, slug }) => [coordinate, slug]));
}

const MIXED_TAGS: Record<string, PathItem> = {
  "/v1/locations": { get: { operationId: "listLocations", tags: ["Locations"], ...OK } },
  "/v1/users/{id}": {
    parameters: [ID_PARAM],
    get: { operationId: "getUser", tags: ["User Management"], ...OK },
  },
  "/v1/keys": { post: { operationId: "createKey", tags: ["APIKeys"], ...OK } },
};

// ── AC 1: the tag projection ───────────────────────────────────────────────

describe("policyTagRouteSegment: v2 tag slugs", () => {
  test("tags take the operation slug projection", () => {
    assert.equal(policyTagRouteSegment("Locations"), "locations");
    assert.equal(policyTagRouteSegment("User Management"), "user-management");
    assert.equal(policyTagRouteSegment("APIKeys"), "api-keys");
    assert.equal(policyTagRouteSegment("Air quality"), "air-quality");
  });

  test("a projection that empties out falls back to a stable, distinct hash", () => {
    const ja = policyTagRouteSegment("日本語");
    assert.match(ja, /^tag-[a-z0-9]+$/);
    assert.equal(ja, policyTagRouteSegment("日本語"));
    assert.match(policyTagRouteSegment("___"), /^tag-[a-z0-9]+$/);
    assert.notEqual(policyTagRouteSegment("___"), ja);
  });

  test("every projection passes the route-policy segment grammar", () => {
    for (const tag of ["Locations", "User Management", "APIKeys", "日本語", "___", "../evil", "a--b"]) {
      assert.equal(routeSlugFault(policyTagRouteSegment(tag)), undefined, tag);
    }
  });
});

// ── AC 2 and 3: v1 and legacy frozen; operations identical ─────────────────

describe("v1 and legacy keep their tag URLs; v2 operations are v1's", () => {
  test("a v1 collection still routes tags with the spec's casing", async () => {
    const v1 = await slugsOf("rp2-v1", MIXED_TAGS, V1);
    assert.equal(v1.get("tags.User Management"), "tags/User-Management");
    assert.equal(v1.get("tags.Locations"), "tags/Locations");
    const legacy = await slugsOf("rp2-legacy", MIXED_TAGS, undefined);
    assert.equal(legacy.get("tags.User Management"), "tags/User-Management");
    assert.equal(legacy.get("getUser"), "User-Management/getUser");
    assert.equal(tagRouteSegment("Accounts"), "Accounts");
  });

  test("v2 lowercases only the tag pages", async () => {
    const v2 = await slugsOf("rp2-v2", MIXED_TAGS, V2);
    assert.equal(v2.get("tags.User Management"), "tags/user-management");
    assert.equal(v2.get("tags.Locations"), "tags/locations");
    assert.equal(v2.get("tags.APIKeys"), "tags/api-keys");
  });

  test("on the same spec, v1 and v2 produce identical operation slugs and provenance", async () => {
    const smallco = readFileSync(
      fileURLToPath(new URL("./fixtures/api/smallco.yaml", import.meta.url)),
      "utf8",
    );
    for (const [name, source] of [
      ["smallco", smallco],
      ["mixed", spec(MIXED_TAGS)],
    ] as const) {
      const a = await buildApiModel({ collection: `rp2-par-${name}-a`, spec: source, routes: V1 });
      const b = await buildApiModel({ collection: `rp2-par-${name}-b`, spec: source, routes: V2 });
      const ops = (m: typeof a) =>
        getApiPageSlugs(m)
          .filter(({ coordinate, slug }) => slug !== "" && !coordinate.startsWith("tags."))
          .map(({ coordinate, slug }) => [coordinate, slug]);
      assert.deepEqual(ops(a), ops(b), `${name}: operation slugs`);
      assert.deepEqual(
        [...getApiRouteProvenance(a)].sort(),
        [...getApiRouteProvenance(b)].sort(),
        `${name}: provenance`,
      );
    }
  });
});

// ── AC 4: page-producing tags only ─────────────────────────────────────────

describe("v2 routes only tags that produce a page", () => {
  const grouped = {
    "x-tagGroups": [{ name: "Account & User Management", tags: ["Accounts", "Members"] }],
    tags: [
      { name: "Accounts", "x-displayName": "Customer Accounts" },
      { name: "Members", parent: "Accounts" },
    ],
  };
  const paths: Record<string, PathItem> = {
    "/accounts": { get: { operationId: "accountsList", tags: ["Accounts"], ...OK } },
    "/accounts/members": { get: { operationId: "membersList", tags: ["Members"], ...OK } },
  };

  test("a child tag under a nav-only category gets the v2 URL; the category gets none", async () => {
    const model = await buildApiModel({ collection: "rp2-grouped", spec: spec(paths, grouped), routes: V2 });
    const slugs = new Map(getApiPageSlugs(model).map(({ coordinate, slug }) => [coordinate, slug]));
    assert.equal(slugs.get("tags.Members"), "tags/members");
    assert.equal(slugs.has("tags.Account & User Management"), false);
    const category = getApiNav(model).items.find((i) => i.label === "Account & User Management");
    assert.ok(category);
    assert.equal(category.href, undefined);
  });

  test("x-displayName labels the section and changes no slug", async () => {
    const model = await buildApiModel({ collection: "rp2-display", spec: spec(paths, grouped), routes: V2 });
    const slugs = new Map(getApiPageSlugs(model).map(({ coordinate, slug }) => [coordinate, slug]));
    assert.equal(slugs.get("tags.Accounts"), "tags/accounts");
    const category = getApiNav(model).items.find((i) => i.label === "Account & User Management")!;
    assert.ok(category.children.some((c) => c.label === "Customer Accounts"));
  });
});

// ── AC 5: tag collisions ───────────────────────────────────────────────────

describe("two tags that project to one v2 slug", () => {
  const paths: Record<string, PathItem> = {
    "/a": { get: { operationId: "aList", tags: ["User Management"], ...OK } },
    "/b": { get: { operationId: "bList", tags: ["user-management"], ...OK } },
  };

  test("fail the build naming both tags", async () => {
    await assert.rejects(
      () => buildApiModel({ collection: "rp2-collide", spec: spec(paths), routes: V2 }),
      (err: Error) => {
        assert.match(err.message, /both map to the\s+route slug "tags\/user-management"/);
        assert.match(err.message, /"tags\.User Management"/);
        assert.match(err.message, /"tags\.user-management"/);
        assert.match(err.message, /Rename one operation, schema, tag, or webhook/);
        return true;
      },
    );
  });

  test("build under v1, where the projections differ", async () => {
    const v1 = await slugsOf("rp2-collide-v1", paths, { convention: "resource-action-v1" });
    assert.equal(v1.get("tags.User Management"), "tags/User-Management");
    assert.equal(v1.get("tags.user-management"), "tags/user-management");
  });
});

// ── AC 8: config errors ────────────────────────────────────────────────────

describe("routes config validation", () => {
  const withApi = (api: unknown[]) =>
    ({ site: "https://example.com", title: "T", api }) as Parameters<typeof validateNimbusConfig>[0];

  test("resource-action-v2 is accepted with the same fields as v1", () => {
    assert.doesNotThrow(() =>
      validateNimbusConfig(
        withApi([
          {
            collection: "s",
            spec: "./s.json",
            routes: { convention: "resource-action-v2", stripPathPrefixes: ["/v1"], operations: { a: "x/y" } },
          },
        ]),
      ),
    );
  });

  test("an unknown convention names both accepted values", () => {
    assert.throws(
      () =>
        validateNimbusConfig(
          withApi([{ collection: "s", spec: "./s.json", routes: { convention: "resource-action-v3" } }]),
        ),
      /must be "resource-action-v1" or "resource-action-v2"/,
    );
  });
});

// ── AC 6 and 7: one real build ─────────────────────────────────────────────

const SRC_DIR = path.resolve(import.meta.dirname, "../src");
const mod = (file: string) => JSON.stringify(pathToFileURL(path.join(SRC_DIR, file)).href);

// The API catch-all, shaped like the installed route: NimbusHead in the head
// (the social image), and a body listing every generated href surface — nav,
// breadcrumbs, the page's own URL and the version alternates.
function apiPage(collection: string): string {
  return `---
import { getApiRoute, getApiStaticPaths, getApiVersionAlternates } from ${mod("runtime.ts")};
import NimbusHead from ${mod("components/NimbusHead.astro")};
export const prerender = true;
export const getStaticPaths = getApiStaticPaths(${JSON.stringify(collection)});
const result = await getApiRoute(Astro);
if (result instanceof Response) return result;
const { page, nav, collection, version, coordinate } = result;
const pagePathname = new URL(page.href, Astro.url).pathname;
const socialImage = new URL(page.href, Astro.url).search
  ? undefined
  : "/og" + pagePathname.replace(/^\\/docs/, "").replace(/\\/$/, "") + ".png";
const record = version ? await getApiVersionAlternates(collection, version, coordinate) : null;
const links: string[] = [];
const walk = (items: Array<{ href?: string; children?: unknown[] }>) => {
  for (const item of items) {
    if (item.href) links.push(item.href);
    walk((item.children ?? []) as Array<{ href?: string; children?: unknown[] }>);
  }
};
walk(nav.items as never);
---
<html>
  <head>
    <NimbusHead title={page.title} collection={collection} apiVersion={version ?? undefined} coordinate={coordinate} markdownUrl={page.markdownHref} socialImage={socialImage} />
  </head>
  <body>
    <main>
      {links.map((href) => <a class="nav" href={href}>n</a>)}
      {page.breadcrumbs.map((crumb) => (crumb.href ? <a class="crumb" href={crumb.href}>c</a> : null))}
      <a class="self" href={page.href}>self</a>
      {record ? record.alternates.map((alt) => <a class="alt" href={alt.url}>{alt.version}</a>) : null}
    </main>
  </body>
</html>
`;
}

function familySpec(version: string): string {
  return JSON.stringify(
    spec({
      "/users": { get: { operationId: "listUsers", summary: `List (${version})`, tags: ["User Management"], ...OK } },
    }),
  );
}

// A three-level tag hierarchy for `sections: "hierarchical"`.
const TREE_TAGS = [{ name: "zones" }, { name: "zones-dns", parent: "zones" }, { name: "zones-dns-records", parent: "zones-dns" }];
function treeSpec(version: string): string {
  return JSON.stringify(
    spec(
      { "/records": { get: { operationId: "listRecords", summary: `Records (${version})`, tags: ["zones-dns-records"], ...OK } } },
      { tags: TREE_TAGS },
    ),
  );
}

let root: string;
let app: { render(request: Request): Promise<Response> };

// View-model hrefs exclude Astro's base (components apply it at the boundary),
// so every check matches the path's tail.
const hrefs = (html: string, cls: string): string[] =>
  [...html.matchAll(new RegExp(`class="${cls}" href="([^"]+)"`, "g"))].map((m) => m[1]!);
const has = (list: string[], tail: string) => list.some((h) => h.endsWith(tail));

before(async () => {
  root = await mkdtemp(path.join(TEST_TMP, "nimbus-route-policy-v2-"));
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
  await write("specs/zones.json", JSON.stringify(spec(MIXED_TAGS)));
  for (const v of ["v2", "v1"]) {
    await write(`specs/fam-${v}.json`, familySpec(v));
    await write(`specs/qfam-${v}.json`, familySpec(v));
  }
  await write("specs/tree.json", treeSpec("tree"));
  for (const v of ["nested", "flat"]) await write(`specs/hfam-${v}.json`, treeSpec(v));
  await write(
    "src/content.config.ts",
    `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection } from ${mod("content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  zones: defineCollection(apiCollection()),
  fam: defineCollection(apiCollection()),
  qfam: defineCollection(apiCollection()),
  tree: defineCollection(apiCollection()),
  hfam: defineCollection(apiCollection()),
};`,
  );
  await write(
    "src/content/docs/guide.md",
    "---\ntitle: Guide\n---\n\n[users](<api.ref:zones:tags.User Management>) and [locations](api.ref:zones:tags.Locations).\n",
  );
  await write(
    "src/pages/[...slug].astro",
    `---
import { getDocsStaticPaths, getDocsPageProps } from ${mod("runtime.ts")};
export const prerender = true;
export const getStaticPaths = getDocsStaticPaths;
const { Content } = await getDocsPageProps(Astro);
---
<html><body><Content /></body></html>
`,
  );
  await write("src/pages/index.astro", "<html><body><h1>Home</h1></body></html>\n");
  for (const c of ["zones", "fam", "qfam", "tree", "hfam"]) await write(`src/pages/${c}/[...slug].astro`, apiPage(c));
  await write(
    "src/pages/[...slug]/index.md.ts",
    `import { markdownRoute } from ${mod("agent-endpoints.ts")};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = markdownRoute();`,
  );
  await write(
    "src/pages/llms.txt.ts",
    `import { llmsRoute } from ${mod("agent-endpoints.ts")};\nexport const prerender = true;\nexport const { GET } = llmsRoute();`,
  );
  await write(
    "src/pages/[section]/llms.txt.ts",
    `import { llmsSectionRoute } from ${mod("agent-endpoints.ts")};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = llmsSectionRoute();`,
  );
  await write(
    "src/pages/nimbus-api/coordinates.json.ts",
    `import { getCoordinatesManifest } from ${mod("runtime.ts")};\nexport const prerender = true;\nexport async function GET() { return new Response(JSON.stringify(await getCoordinatesManifest())); }`,
  );
  // What the search staging and the OG route read: every indexed page's URL
  // and card path.
  await write(
    "src/pages/indexed.json.ts",
    `import { getIndexedEntries } from ${mod("runtime.ts")};\nexport const prerender = true;\nexport async function GET() { const items = await getIndexedEntries(); return new Response(JSON.stringify(items.map((i) => ({ url: i.url, og: i.ogImageUrl })))); }`,
  );
  await write(
    "server-entry.mjs",
    'import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n',
  );
  // The request-rendering gate string-matches the adapter name.
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
          rendering: { default: "build", collections: { qfam: "request" } },
          api: [
            { collection: "zones", spec: "./specs/zones.json", routes: V2 },
            {
              collection: "fam",
              versions: [
                { version: "v2", spec: "./specs/fam-v2.json", default: true, routes: { convention: "resource-action-v2" } },
                { version: "v1", spec: "./specs/fam-v1.json", routes: { convention: "resource-action-v1" } },
              ],
            },
            {
              collection: "tree",
              spec: "./specs/tree.json",
              routes: { convention: "resource-action-v2", sections: "hierarchical" },
            },
            {
              collection: "hfam",
              versions: [
                {
                  version: "nested",
                  spec: "./specs/hfam-nested.json",
                  default: true,
                  routes: { convention: "resource-action-v2", sections: "hierarchical" },
                },
                { version: "flat", spec: "./specs/hfam-flat.json", routes: { convention: "resource-action-v2" } },
              ],
            },
            {
              collection: "qfam",
              versionUrl: { in: "query" },
              versions: [
                { version: "v2", spec: "./specs/qfam-v2.json", default: true, routes: { convention: "resource-action-v2" } },
                { version: "v1", spec: "./specs/qfam-v1.json", routes: { convention: "resource-action-v1" } },
              ],
            },
          ],
        } as Parameters<typeof nimbus>[0],
        { admonitions: false, sitemap: true, validateMdx: false },
      ),
    ],
  } as never);
  ({ app } = (await import(pathToFileURL(path.join(root, ".server/entry.mjs")).href)) as { app: typeof app });
});

after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

const dist = (rel: string) => path.join(root, "dist", rel);
const read = (rel: string) => readFile(dist(rel), "utf8");

async function rendered(url: string): Promise<string> {
  const response = await app.render(new Request(`https://example.test${url}`));
  assert.equal(response.status, 200, url);
  return response.text();
}

describe("every surface agrees on the v2 tag URL (non-/api mount, base /docs)", () => {
  test("the tag page and its Markdown twin are written at the lowercase path only", async () => {
    assert.ok(existsSync(dist("zones/tags/locations/index.html")));
    assert.ok(existsSync(dist("zones/tags/user-management/index.md")));
    // `existsSync` is case-blind on macOS; the directory listing is not.
    assert.deepEqual((await readdir(dist("zones/tags"))).sort(), ["api-keys", "locations", "user-management"]);
    const md = await read("zones/tags/locations/index.md");
    assert.doesNotMatch(md, /tags\/Locations/);
  });

  test("sidebar, section page and breadcrumbs", async () => {
    const overview = await read("zones/index.html");
    const nav = hrefs(overview, "nav");
    assert.ok(has(nav, "/zones/tags/locations/"), nav.join(" "));
    assert.ok(has(nav, "/zones/tags/user-management/"));
    assert.ok(nav.every((h) => !/tags\/[A-Z]/.test(h)));
    const section = await read("zones/tags/locations/index.html");
    assert.ok(has(hrefs(section, "self"), "/zones/tags/locations/"));
    const operation = await read("zones/locations/list/index.html");
    assert.ok(has(hrefs(operation, "crumb"), "/zones/tags/locations/"));
  });

  test("an api.ref citation resolves to the v2 URL", async () => {
    const guide = await read("guide/index.html");
    assert.match(guide, /href="(?:\/docs)?\/zones\/tags\/user-management\/"/);
    assert.match(guide, /href="(?:\/docs)?\/zones\/tags\/locations\/"/);
    assert.doesNotMatch(guide, /tags\/(?:Locations|User-Management)/);
  });

  test("coordinates.json, llms.txt and the sitemap", async () => {
    const manifest = await read("nimbus-api/coordinates.json");
    assert.match(manifest, /"tags\.Locations"/);
    assert.match(manifest, /"url":"\/zones\/tags\/locations"/);
    assert.doesNotMatch(manifest, /tags\/Locations/);
    assert.match(await read("llms.txt"), /\/zones\/llms\.txt/, "the root index lists the section");
    const section = await read("zones/llms.txt");
    assert.match(section, /\/zones\/tags\/locations\//);
    assert.doesNotMatch(section, /tags\/Locations/);
    const sitemap = await read("sitemap-0.xml");
    assert.match(sitemap, /https:\/\/example\.test\/docs\/zones\/tags\/locations\//);
    assert.match(sitemap, /\/fam\/v1\/tags\/User-Management\//, "the v1 version keeps its tag URL");
    assert.doesNotMatch(sitemap, /tags\/Locations/);
  });

  test("search staging and the OG card read the same URL", async () => {
    const indexed = JSON.parse(await read("indexed.json")) as Array<{ url: string; og: string }>;
    const tag = indexed.find((i) => i.url === "/zones/tags/locations/");
    assert.ok(tag, JSON.stringify(indexed));
    assert.equal(tag.og, "/og/zones/tags/locations.png");
    assert.ok(indexed.filter((i) => i.url.startsWith("/zones/")).every((i) => !/tags\/[A-Z]/.test(i.url)));
    const section = await read("zones/tags/locations/index.html");
    assert.match(section, /property="og:image"[^>]*\/og\/zones\/tags\/locations\.png/);
  });
});

describe("a family mixing v1 and v2 links each tag page to its counterpart", () => {
  test("path-versioned", async () => {
    const current = await read("fam/tags/user-management/index.html");
    assert.ok(has(hrefs(current, "alt"), "/fam/v1/tags/User-Management/"), hrefs(current, "alt").join(" "));
    const old = await read("fam/v1/tags/User-Management/index.html");
    assert.ok(has(hrefs(old, "alt"), "/fam/tags/user-management/"), hrefs(old, "alt").join(" "));
  });

  test("query-versioned", async () => {
    const current = await rendered("/docs/qfam/tags/user-management/");
    const alts = hrefs(current, "alt");
    assert.ok(has(alts, "/qfam/tags/User-Management/?version=v1"), alts.join(" "));
    const old = await rendered("/docs/qfam/tags/User-Management/?version=v1");
    assert.ok(has(hrefs(old, "alt"), "/qfam/tags/user-management/"), hrefs(old, "alt").join(" "));
  });
});

describe("every surface agrees on a hierarchical section URL", () => {
  test("the section page and its Markdown twin are written at the nested path only", async () => {
    assert.ok(existsSync(dist("tree/zones/dns/records/index.html")));
    assert.ok(existsSync(dist("tree/zones/dns/records/index.md")));
    assert.ok(existsSync(dist("tree/zones/dns/index.html")));
    assert.equal(existsSync(dist("tree/tags")), false);
  });

  test("sidebar, section page, breadcrumbs and the operation's crumb", async () => {
    const overview = await read("tree/index.html");
    const nav = hrefs(overview, "nav");
    assert.ok(has(nav, "/tree/zones/dns/records/"), nav.join(" "));
    assert.ok(nav.every((h) => !h.includes("/tags/")), nav.join(" "));
    const section = await read("tree/zones/dns/records/index.html");
    assert.ok(has(hrefs(section, "self"), "/tree/zones/dns/records/"));
    const crumbs = hrefs(section, "crumb");
    assert.ok(has(crumbs, "/tree/zones/") && has(crumbs, "/tree/zones/dns/"), crumbs.join(" "));
    const operation = await read("tree/records/list/index.html");
    assert.ok(has(hrefs(operation, "crumb"), "/tree/zones/dns/records/"));
  });

  test("coordinates.json, llms.txt and the sitemap", async () => {
    const manifest = await read("nimbus-api/coordinates.json");
    assert.match(manifest, /"url":"\/tree\/zones\/dns\/records"/);
    assert.match(await read("tree/llms.txt"), /\/tree\/zones\/dns\/records\//);
    assert.match(await read("sitemap-0.xml"), /https:\/\/example\.test\/docs\/tree\/zones\/dns\/records\//);
  });

  test("a family mixing flat and hierarchical sections links each section page to its counterpart", async () => {
    const nested = await read("hfam/zones/dns/records/index.html");
    assert.ok(has(hrefs(nested, "alt"), "/hfam/flat/tags/zones-dns-records/"), hrefs(nested, "alt").join(" "));
    const flat = await read("hfam/flat/tags/zones-dns-records/index.html");
    assert.ok(has(hrefs(flat, "alt"), "/hfam/zones/dns/records/"), hrefs(flat, "alt").join(" "));
  });
});

// ── AC 9: the route errors the recipe reacts to ────────────────────────────
// The recipe never predicts a slug; it builds and reads these messages. Each
// shape it handles is pinned here, with the resolution it applies.

describe("the recipe's route-error contract", () => {
  const V2_PLAIN: RoutePolicy = { convention: "resource-action-v2" };
  const itemsPair = (ids: boolean): Record<string, PathItem> => ({
    "/items/{id}": {
      parameters: [ID_PARAM],
      put: { ...(ids ? { operationId: "replaceItem" } : {}), ...OK },
      patch: { ...(ids ? { operationId: "patchItem" } : {}), ...OK },
    },
  });

  test("a PUT/PATCH pair with operationIds: collision names both, one override resolves it", async () => {
    await assert.rejects(
      () => buildApiModel({ collection: "rp2-pair", spec: spec(itemsPair(true)), routes: V2_PLAIN }),
      (err: Error) => {
        assert.match(err.message, /both map to the\s+route slug "items\/update"/);
        assert.match(err.message, /"replaceItem"/);
        assert.match(err.message, /"patchItem"/);
        return true;
      },
    );
    const fixed = await slugsOf("rp2-pair-fixed", itemsPair(true), {
      ...V2_PLAIN,
      operations: { replaceItem: "items/replace" },
    });
    assert.equal(fixed.get("replaceItem"), "items/replace");
    assert.equal(fixed.get("patchItem"), "items/update");
  });

  test("a reserved first segment: the error names it, a non-reserved override resolves it", async () => {
    const paths: Record<string, PathItem> = { "/schemas": { get: { operationId: "listSchemas", ...OK } } };
    await assert.rejects(
      () => buildApiModel({ collection: "rp2-reserved", spec: spec(paths), routes: V2_PLAIN }),
      /route slug "schemas\/list", whose top-level segment "schemas" is a\s+reserved route/,
    );
    const fixed = await slugsOf("rp2-reserved-fixed", paths, { ...V2_PLAIN, operations: { listSchemas: "list-schemas" } });
    assert.equal(fixed.get("listSchemas"), "list-schemas");
  });

  test("a PUT/PATCH pair without operationIds fails under v2 and builds without routes", async () => {
    await assert.rejects(
      () => buildApiModel({ collection: "rp2-pair-noid", spec: spec(itemsPair(false)), routes: V2_PLAIN }),
      /both map to the\s+route slug "items\/update"/,
    );
    const legacy = await slugsOf("rp2-pair-noid-legacy", itemsPair(false), undefined);
    assert.equal(legacy.size >= 3, true, "the legacy build resolves both operations");
  });

  test("tags that collide only in lowercase fail under v2 and build without routes", async () => {
    const paths: Record<string, PathItem> = {
      "/a": { get: { operationId: "aList", tags: ["Accounts"], ...OK } },
      "/b": { get: { operationId: "bList", tags: ["accounts"], ...OK } },
    };
    await assert.rejects(
      () => buildApiModel({ collection: "rp2-tags-case", spec: spec(paths), routes: V2_PLAIN }),
      (err: Error) => {
        assert.match(err.message, /route slug "tags\/accounts"/);
        assert.match(err.message, /"tags\.Accounts"/);
        assert.match(err.message, /"tags\.accounts"/);
        return true;
      },
    );
    const legacy = await slugsOf("rp2-tags-case-legacy", paths, undefined);
    assert.equal(legacy.get("tags.Accounts"), "tags/Accounts");
    assert.equal(legacy.get("tags.accounts"), "tags/accounts");
  });

  test("tags that collide under both projections fail with and without routes, naming both", async () => {
    const paths: Record<string, PathItem> = {
      "/a": { get: { operationId: "aList", tags: ["User Management"], ...OK } },
      "/b": { get: { operationId: "bList", tags: ["User-Management"], ...OK } },
    };
    for (const [collection, routes] of [
      ["rp2-tags-both-v2", V2_PLAIN],
      ["rp2-tags-both-legacy", undefined],
    ] as const) {
      await assert.rejects(
        () => buildApiModel({ collection, spec: spec(paths), routes }),
        (err: Error) => {
          assert.match(err.message, /"tags\.User Management"/);
          assert.match(err.message, /"tags\.User-Management"/);
          assert.match(err.message, /Rename one operation, schema, tag, or webhook/);
          return true;
        },
      );
    }
  });
});
