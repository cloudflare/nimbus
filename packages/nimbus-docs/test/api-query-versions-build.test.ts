// Query-addressed API versions, end to end: one real server build with a
// query-mode family (default + old + hidden version) beside a path-mode
// family, then requests against the generated app. Covers route resolution
// (store ids are not routes), the rendered same-version links, the picker,
// the head (noindex / canonical / Markdown alternate / social image),
// default-only agent assets, and the final sitemap.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, before, after } from "node:test";

import { build, type AstroIntegration } from "astro";

import nimbus from "../src/index.ts";
import { runningNimbusVersion } from "../src/_internal/upgrades.ts";

const SRC_DIR = path.resolve(import.meta.dirname, "../src");

function spec(
  version: string,
  ops: Array<[string, string, string]>,
): string {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [method, p, operationId] of ops) {
    paths[p] = {
      ...(paths[p] ?? {}),
      [method]: {
        operationId,
        summary: `${operationId} (${version})`,
        responses: { "200": { description: "ok" } },
      },
    };
  }
  return JSON.stringify({
    openapi: "3.0.0",
    info: { title: `QV ${version}`, version: "1.0.0" },
    paths,
  });
}

// The canonical API catch-all, shaped like the installed route: NimbusHead in
// the head, and a body that enumerates every generated same-version surface —
// nav links, breadcrumbs, the page's own URL, the alternates, the picker.
const QV_PAGE = `---
import {
  getApiRoute,
  getApiStaticPaths,
  getApiVersions,
  getApiVersionAlternates,
} from "@cloudflare/nimbus-docs/runtime";
import NimbusHead from "@cloudflare/nimbus-docs/components/NimbusHead.astro";

export const prerender = true;
export const getStaticPaths = getApiStaticPaths("qv");

const result = await getApiRoute(Astro);
if (result instanceof Response) return result;
const { page, nav, collection, version, coordinate } = result;
const pagePathname = new URL(page.href, Astro.url).pathname;
const socialImage = new URL(page.href, Astro.url).search
  ? undefined
  : "/og" + pagePathname.replace(/\\/$/, "") + ".png";
const versions = (await getApiVersions(collection)) ?? [];
const record = version
  ? await getApiVersionAlternates(collection, version, coordinate)
  : null;
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
    <NimbusHead
      title={page.title}
      collection={collection}
      apiVersion={version ?? undefined}
      coordinate={coordinate}
      markdownUrl={page.markdownHref}
      socialImage={socialImage}
    />
  </head>
  <body>
    <main data-version={version ?? ""} data-markdown={page.markdownHref ?? "none"}>
      {links.map((href) => <a class="nav" href={href}>n</a>)}
      {page.breadcrumbs.map((crumb) =>
        crumb.href ? <a class="crumb" href={crumb.href}>c</a> : null,
      )}
      <a class="self" href={page.href}>self</a>
      {record
        ? record.alternates.map((alt) => (
            <a class="alt" href={alt.url}>{alt.version}</a>
          ))
        : null}
      {versions
        .filter((v) => !v.hidden)
        .map((v) => (
          <a class="picker" href={v.url} data-default={String(v.isDefault)}>
            {v.version}
          </a>
        ))}
    </main>
  </body>
</html>
`;

const CORE_PAGE = `---
import { getApiRoute, getApiStaticPaths } from "@cloudflare/nimbus-docs/runtime";
export const prerender = true;
export const getStaticPaths = getApiStaticPaths("core");
const result = await getApiRoute(Astro);
if (result instanceof Response) return result;
const { page, version } = result;
---
<html>
  <body>
    <main data-version={version ?? "none"} data-title={page.title}>
      <a class="self" href={page.href}>self</a>
    </main>
  </body>
</html>
`;

// The explicit-options path (`apiCollection({ ... })`) plus the public
// `getApiModel`: both must produce query-form models.
const QX_PAGE = `---
import { getApiRoute, getApiStaticPaths } from "@cloudflare/nimbus-docs/runtime";
import { getApiModel, getApiNav } from "@cloudflare/nimbus-docs/api";
export const prerender = true;
export const getStaticPaths = getApiStaticPaths("qx");
const result = await getApiRoute(Astro);
if (result instanceof Response) return result;
const { page, version } = result;
const model = await getApiModel("qx", "v1");
const nav = getApiNav(model);
const hrefs: string[] = [];
const walk = (items: Array<{ href?: string; children?: unknown[] }>) => {
  for (const item of items) {
    if (item.href) hrefs.push(item.href);
    walk((item.children ?? []) as Array<{ href?: string; children?: unknown[] }>);
  }
};
walk(nav.items as never);
---
<html>
  <body>
    <main
      data-version={version ?? "none"}
      data-markdown={page.markdownHref ?? "none"}
      data-model-hrefs={hrefs.join(" ")}
    >
      <a class="self" href={page.href}>s</a>
    </main>
  </body>
</html>
`;

let root: string;
let app: { render(request: Request): Promise<Response> };

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-query-versions-"));
  const write = async (relative: string, contents: string) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents, "utf8");
  };
  await symlink(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await write(
    "nimbus.json",
    `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`,
  );
  await write(
    "specs/v2.json",
    spec("v2", [
      ["get", "/pets", "list-pets"],
      ["post", "/pets", "create-pet"],
    ]),
  );
  await write(
    "specs/v1.json",
    spec("v1", [
      ["get", "/pets", "list-pets"],
      // Same operation as the default's create-pet under a different id —
      // the shape fallback pairs them, so the slugs differ across versions.
      ["post", "/pets", "make-pet"],
      ["get", "/legacy", "legacy-report"],
    ]),
  );
  await write("specs/v0.json", spec("v0", [["get", "/pets", "list-pets"]]));
  await write("specs/core.json", spec("core", [["get", "/charges", "create-charge"]]));
  await write("specs/qx-v2.json", spec("qx-v2", [["get", "/ping", "ping"]]));
  await write("specs/qx-v1.json", spec("qx-v1", [["get", "/ping", "ping"]]));
  await write(
    "src/content.config.ts",
    `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection } from ${JSON.stringify(pathToFileURL(path.join(SRC_DIR, "content.ts")).href)};
export const collections = {
  docs: defineCollection(docsCollection()),
  qv: defineCollection(apiCollection()),
  core: defineCollection(apiCollection()),
  qx: defineCollection(apiCollection({
    collection: "qx",
    versionMode: "path",
    versions: [
      { version: "v2", spec: "./specs/qx-v2.json", default: true },
      { version: "v1", spec: "./specs/qx-v1.json" },
    ],
  })),
};`,
  );
  await write("src/content/docs/guide.md", "---\ntitle: Guide\n---\n\nText.\n");
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
  await write("src/pages/qv/[...slug].astro", QV_PAGE);
  await write("src/pages/core/[...slug].astro", CORE_PAGE);
  await write("src/pages/qx/[...slug].astro", QX_PAGE);
  await write(
    "src/pages/index.astro",
    "<html><body><h1>Home</h1></body></html>\n",
  );
  await write(
    "server-entry.mjs",
    'import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n',
  );

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
    build: { server: path.join(root, ".server"), client: path.join(root, "dist") },
    vite: {
      cacheDir: path.join(root, ".vite"),
      resolve: {
        alias: [
          {
            find: /^@cloudflare\/nimbus-docs$/,
            replacement: path.join(SRC_DIR, "index.ts"),
          },
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
          rendering: {
            default: "build",
            collections: { qv: "request", core: "request", qx: "request" },
          },
          api: [
            {
              collection: "qv",
              versionMode: "query",
              versions: [
                { version: "v2", spec: "./specs/v2.json", default: true },
                { version: "v1", spec: "./specs/v1.json" },
                { version: "v0", spec: "./specs/v0.json", hidden: true },
              ],
            },
            { collection: "core", spec: "./specs/core.json" },
            {
              collection: "qx",
              versionMode: "query",
              versions: [
                { version: "v2", spec: "./specs/qx-v2.json", default: true },
                { version: "v1", spec: "./specs/qx-v1.json" },
              ],
            },
          ],
        } as Parameters<typeof nimbus>[0],
        { admonitions: false, sitemap: true, validateMdx: false },
      ),
    ],
  } as never);
  ({ app } = (await import(
    pathToFileURL(path.join(root, ".server/entry.mjs")).href
  )) as { app: typeof app });
});

after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function page(url: string): Promise<{ status: number; html: string }> {
  const response = await app.render(new Request(`https://example.test${url}`));
  return { status: response.status, html: await response.text() };
}

const hrefsOf = (html: string, cls: string): string[] =>
  [...html.matchAll(new RegExp(`<a(?=[^>]*class="${cls}")[^>]*href="([^"]*)"`, "g"))].map(
    (m) => m[1]!,
  );

test("the version comes from the query: default, explicit, empty, unknown, hidden", async () => {
  const bare = await page("/qv/list-pets/");
  assert.equal(bare.status, 200);
  assert.match(bare.html, /data-version="v2"/);
  assert.match(bare.html, /list-pets \(v2\)/);

  const explicit = await page("/qv/list-pets/?version=v2");
  assert.equal(explicit.status, 200);
  assert.match(explicit.html, /data-version="v2"/);

  const empty = await page("/qv/list-pets/?version=");
  assert.equal(empty.status, 200);
  assert.match(empty.html, /data-version="v2"/);

  const old = await page("/qv/list-pets/?version=v1");
  assert.equal(old.status, 200);
  assert.match(old.html, /data-version="v1"/);
  assert.match(old.html, /list-pets \(v1\)/);

  const unknown = await page("/qv/list-pets/?version=nope");
  assert.equal(unknown.status, 404);

  const hidden = await page("/qv/list-pets/?version=v0");
  assert.equal(hidden.status, 200);
  assert.match(hidden.html, /data-version="v0"/);
});

test("store ids are not routes: version-prefixed paths 404, hidden included", async () => {
  for (const url of [
    "/qv/v1/list-pets/",
    "/qv/v1/",
    "/qv/v0/list-pets/",
    "/qv/v1/legacy-report/",
  ]) {
    assert.equal((await page(url)).status, 404, url);
  }
});

test("a slug only in an old version 404s bare and renders with its query", async () => {
  assert.equal((await page("/qv/legacy-report/")).status, 404);
  const versioned = await page("/qv/legacy-report/?version=v1");
  assert.equal(versioned.status, 200);
  assert.match(versioned.html, /data-version="v1"/);
});

test("a path-mode family ignores the parameter", async () => {
  const bare = await page("/core/create-charge/");
  assert.equal(bare.status, 200);
  const withParam = await page("/core/create-charge/?version=bogus");
  assert.equal(withParam.status, 200);
  assert.match(withParam.html, /data-version="none"/);
});

test("every generated same-version link in a non-default page carries its query; the default's carry none", async () => {
  const old = await page("/qv/list-pets/?version=v1");
  for (const cls of ["nav", "crumb", "self"]) {
    const hrefs = hrefsOf(old.html, cls);
    assert.ok(hrefs.length > 0, `${cls} links exist`);
    for (const href of hrefs) {
      assert.match(
        href,
        /\?version=v1$/,
        `${cls} link ${href} carries the version`,
      );
    }
  }

  const def = await page("/qv/list-pets/");
  for (const cls of ["nav", "crumb", "self"]) {
    for (const href of hrefsOf(def.html, cls)) {
      assert.ok(
        !/[?&]version=/.test(href),
        `${cls} link ${href} is version-free`,
      );
    }
  }
});

test("picker entries carry their destination's query and never list the hidden version", async () => {
  const old = await page("/qv/list-pets/?version=v1");
  const picker = hrefsOf(old.html, "picker");
  assert.deepEqual(picker.sort(), ["/qv/", "/qv/?version=v1"]);
  // Alternates resolve the same coordinate across versions.
  const alts = hrefsOf(old.html, "alt");
  assert.deepEqual(alts, ["/qv/list-pets/"]);

  const def = await page("/qv/list-pets/");
  assert.deepEqual(hrefsOf(def.html, "alt"), ["/qv/list-pets/?version=v1"]);
});

test("head: the default is indexable with its Markdown alternate and card; non-defaults are noindex with the default counterpart as canonical and no Markdown affordance", async () => {
  const def = await page("/qv/list-pets/");
  assert.ok(!/name="robots" content="noindex"/.test(def.html));
  assert.match(
    def.html,
    /rel="canonical" href="https:\/\/example\.test\/qv\/list-pets\/"/,
  );
  assert.match(def.html, /rel="alternate"[^>]*type="text\/markdown"/);
  assert.match(def.html, /property="og:image"[^>]*\/og\/qv\/list-pets\.png/);
  assert.match(def.html, /data-markdown="\/qv\/list-pets\/index\.md"/);

  const old = await page("/qv/list-pets/?version=v1");
  assert.match(old.html, /name="robots" content="noindex"/);
  assert.match(
    old.html,
    /rel="canonical" href="https:\/\/example\.test\/qv\/list-pets\/"/,
  );
  assert.ok(!/type="text\/markdown"/.test(old.html), "no Markdown alternate");
  assert.match(old.html, /data-markdown="none"/);
  assert.ok(
    !/og:image[^>]*list-pets\.png/.test(old.html),
    "no per-page card for a non-default version",
  );

  const oldOnly = await page("/qv/legacy-report/?version=v1");
  assert.match(oldOnly.html, /name="robots" content="noindex"/);
  assert.ok(
    !/rel="canonical"/.test(oldOnly.html),
    "an old-only page has no canonical at all",
  );

  // Slugs differ across versions (shape-fallback pairing): the canonical is
  // the default counterpart's URL, not the page's own query-free path.
  const renamed = await page("/qv/make-pet/?version=v1");
  assert.equal(renamed.status, 200);
  assert.match(
    renamed.html,
    /rel="canonical" href="https:\/\/example\.test\/qv\/create-pet\/"/,
  );
  assert.match(renamed.html, /name="robots" content="noindex"/);
});

test("agent assets cover the default version only, at version-free URLs", async () => {
  // The baked agent assets are static files the CDN serves ahead of the
  // Worker; the test adapter has no static layer, so assert on the build
  // products: the asset manifest and the content-addressed files.
  const manifest = JSON.parse(
    await readFile(
      path.join(root, ".astro/nimbus/agent-endpoint-assets/manifest.json"),
      "utf8",
    ),
  ) as {
    markdownAssets: Array<{ collection: string; id: string; url: string; path: string }>;
    llmsAssets: Array<{ scope: string; section?: string; path: string }>;
  };
  const assetsDir = path.join(root, "dist/_nimbus/agent-endpoint-assets");

  const qvTwins = manifest.markdownAssets
    .filter((asset) => asset.collection === "qv")
    .map((asset) => asset.url)
    .sort();
  assert.deepEqual(qvTwins, [
    "/qv/create-pet/index.md",
    "/qv/index.md",
    "/qv/list-pets/index.md",
  ]);
  for (const url of qvTwins) {
    assert.ok(!/[?&]version=/.test(url) && !/\/qv\/v[01]\//.test(url), url);
  }

  const twinAsset = manifest.markdownAssets.find(
    (asset) => asset.collection === "qv" && asset.id === "list-pets",
  )!;
  const twin = await readFile(path.join(assetsDir, twinAsset.path), "utf8");
  assert.match(twin, /list-pets \(v2\)/, "the twin describes the default version");

  const qvLlms = manifest.llmsAssets.find((asset) => asset.section === "qv")!;
  const llmsText = await readFile(path.join(assetsDir, qvLlms.path), "utf8");
  assert.match(llmsText, /\/qv\/list-pets\//);
  assert.ok(!/[?&]version=/.test(llmsText), "llms.txt is version-free");
  assert.ok(!llmsText.includes("legacy-report"), "no old-version lines");
  assert.ok(!llmsText.includes("/qv/v1/"), "no version-prefixed URLs");

  for (const site of manifest.llmsAssets.filter((asset) => asset.scope === "site")) {
    const text = await readFile(path.join(assetsDir, site.path), "utf8");
    assert.ok(!/[?&]version=/.test(text));
    assert.ok(!text.includes("legacy-report"));
  }
});

test("the sitemap lists each visible path once, version-free, with the family present despite its hidden version", async () => {
  const sitemapFile = ["sitemap-0.xml", "sitemap-index.xml"]
    .map((name) => path.join(root, "dist", name))
    .find((file) => existsSync(file));
  assert.ok(sitemapFile, "a sitemap was written");
  let xml = await readFile(sitemapFile!, "utf8");
  if (sitemapFile!.endsWith("sitemap-index.xml")) {
    xml = await readFile(path.join(root, "dist/sitemap-0.xml"), "utf8");
  }
  assert.ok(!/[?&]version=/.test(xml), "no version queries in the sitemap");
  const occurrences = xml.split("https://example.test/qv/list-pets/</loc>").length - 1;
  assert.equal(occurrences, 1, "each visible path appears exactly once");
  assert.ok(xml.includes("https://example.test/qv/</loc>"), "the family landing is listed");
  assert.ok(!xml.includes("/qv/v1/") && !xml.includes("/qv/v0/"), "no store-id routes");
  assert.ok(!xml.includes("make-pet"), "no non-default pages");
  assert.ok(!xml.includes("legacy-report"), "no old-only pages");
});

test("explicit apiCollection options follow the config entry's versionMode; getApiModel builds query-form models", async () => {
  const old = await page("/qx/ping/?version=v1");
  assert.equal(old.status, 200);
  assert.match(old.html, /data-version="v1"/);
  assert.match(old.html, /data-markdown="none"/);
  for (const href of hrefsOf(old.html, "self")) {
    assert.match(href, /^\/qx\/.*\?version=v1$/);
  }
  // getApiModel("qx", "v1") nav links are query-form, never /qx/v1/… .
  const model = old.html.match(/data-model-hrefs="([^"]*)"/)?.[1] ?? "";
  assert.ok(model.length > 0, "the page rendered model nav hrefs");
  for (const href of model.split(" ")) {
    assert.match(href, /\?version=v1$/, href);
    assert.ok(!href.startsWith("/qx/v1/"), href);
  }
  // Store ids are still not routes on the explicit family.
  assert.equal((await page("/qx/v1/ping/")).status, 404);
});

test("markdown negotiation never substitutes another version's twin", async () => {
  const def = await app.render(
    new Request("https://example.test/qv/list-pets/", {
      headers: { Accept: "text/markdown" },
    }),
  );
  assert.equal(def.status, 200);
  assert.match(def.headers.get("Vary") ?? "", /Accept/, "the default negotiates");

  const old = await app.render(
    new Request("https://example.test/qv/list-pets/?version=v1", {
      headers: { Accept: "text/markdown" },
    }),
  );
  assert.equal(old.status, 200);
  assert.match(
    old.headers.get("Content-Type") ?? "",
    /text\/html/,
    "a non-default version serves its HTML, never the default's Markdown",
  );
  assert.ok(
    !/Accept/.test(old.headers.get("Vary") ?? ""),
    "and does not negotiate at all",
  );
});

test("the homepage advertises only version-free API documentation", async () => {
  const home = await app.render(new Request("https://example.test/"));
  assert.equal(home.status, 200);
  const links = home.headers.get("Link") ?? "";
  assert.ok(links.includes("/qv/"), "the family's version-free docs URL is advertised");
  assert.ok(!links.includes("/qv/v1"), "no non-default query-version URLs");
  assert.ok(!links.includes("/qv/v0"), "no hidden-version URLs");
  assert.ok(!links.includes("/qx/v1"), "none on the explicit family either");
});
