// `sidebar: "on-demand"` end to end, through `astro build`. The client loads a
// collapsed group's rows from the page its `childrenHref` names, so every
// such page must list that group open, prerendered and request-rendered, for
// every version, with Astro's `base` applied once.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import { build, type AstroIntegration } from "astro";

import nimbus from "../src/index.ts";
import { runningNimbusVersion } from "../src/_internal/upgrades.ts";
import { navBuildId, outdatedApiSidebarError } from "../src/_internal/api-sidebar-components.ts";
import {
  buildApiModel,
  getApiNav,
  getApiPageSlugs,
  type ApiNav,
  type ApiNavItem,
} from "../src/api/index.js";
import { setLinkPolicy, toDocumentHref } from "../src/_internal/url.js";
import { TEST_TMP } from "./fixtures/temp-root.js";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const moduleUrl = (relative: string) =>
  JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, relative)).href);
const SPEC = path.resolve(import.meta.dirname, "fixtures/api/smallco.yaml");
const BASE = "/docs";

// v1 groups its tags into x-tagGroups categories, which have no page of their
// own: their rows load from the version's overview.
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
let groupedSpec = "";

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

const PAGE = `---
import { getApiRoute, getApiStaticPaths, navBuildId, navStateScript } from ${moduleUrl("../src/runtime.ts")};
export const prerender = true;
export const getStaticPaths = getApiStaticPaths("api");
const result = await getApiRoute(Astro);
if (result instanceof Response) return result;
---
<main data-nb-nav-build={navBuildId}><nav-json set:html={JSON.stringify(result.nav).replaceAll("<", "\\\\u003c")}></nav-json></main>
<script is:inline aria-hidden="true" set:html={navStateScript} />`;

interface Site {
  get(pathname: string): Promise<{ status: number; body: string }>;
}

async function buildSite(request: boolean): Promise<Site> {
  const root = await mkdtemp(path.join(TEST_TMP, "nimbus-nav-on-demand-"));
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
  const api = {
    collection: "api",
    sidebar: "on-demand" as const,
    versions: [
      { version: "v2", default: true, spec: SPEC },
      { version: "v1", spec: groupedSpec },
    ],
  };
  await write("nimbus.json", `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`);
  await write(
    "src/content.config.ts",
    `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection } from ${moduleUrl("../src/content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  api: defineCollection(apiCollection(${JSON.stringify(api)})),
};`,
  );
  await write("src/content/docs/guide.md", "---\ntitle: Guide\n---\n\nText.\n");
  await write("src/pages/api/[...slug].astro", PAGE);
  // A rendering policy manages every collection's canonical route.
  await write(
    "src/pages/[...slug].astro",
    `---\nimport { getDocsStaticPaths } from ${moduleUrl("../src/runtime.ts")};\nexport const prerender = true;\nexport const getStaticPaths = getDocsStaticPaths;\n---\n<p>doc</p>`,
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
    base: BASE,
    ...(adapter ? { output: "server" as const, adapter } : {}),
    logLevel: "silent",
    integrations: [
      nimbus(
        {
          site: "https://example.test",
          title: "Test",
          description: "Test",
          search: false,
          api: [api],
          ...(request ? { rendering: { default: "build", collections: { api: "request" } } } : {}),
        },
        { admonitions: false, sitemap: false, validateMdx: false },
      ),
    ],
  });

  if (!request) {
    return {
      async get(pathname) {
        const file = path.join(root, "dist", pathname.slice(BASE.length), "index.html");
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
    async get(pathname) {
      const response = await app.render(new Request(`https://example.test${pathname}`));
      return { status: response.status, body: await response.text() };
    },
  };
}

function navOf(html: string): ApiNav {
  const json = /<nav-json>([\s\S]*)<\/nav-json>/.exec(html)?.[1];
  assert.ok(json, "page renders its nav");
  return JSON.parse(json) as ApiNav;
}

const buildIdOf = (html: string) => /data-nb-nav-build="([^"]*)"/.exec(html)?.[1];
const flatten = (items: ApiNavItem[]): ApiNavItem[] =>
  items.flatMap((item) => [item, ...flatten(item.children)]);
const find = (items: ApiNavItem[], coordinate: string) =>
  flatten(items).find((i) => i.coordinate === coordinate);

let versions: { mountPath: string; full: ApiNav; pages: string[] }[];
before(async () => {
  setLinkPolicy({ trailingSlash: "ignore", format: "directory" });
  const dir = await mkdtemp(path.join(TEST_TMP, "nimbus-nav-grouped-"));
  roots.push(dir);
  groupedSpec = path.join(dir, "grouped.json");
  await writeFile(groupedSpec, JSON.stringify(GROUPED));
  versions = [];
  for (const [mountPath, spec] of [["/api", SPEC], ["/api/v1", groupedSpec]]) {
    const model = await buildApiModel({ collection: "api", spec: await readFile(spec!, "utf8"), mountPath });
    const full = getApiNav(model);
    const hrefs = new Map(flatten(full.items).flatMap((i) => (i.href ? [[i.coordinate, i.href]] : [])));
    const pages = getApiPageSlugs(model).map((p) => hrefs.get(p.coordinate) ?? toDocumentHref(mountPath));
    versions.push({ mountPath, full, pages });
  }
});

for (const request of [false, true]) {
  describe(`on-demand, ${request ? "request-rendered" : "prerendered"}`, () => {
    let site: Site;
    before(async () => {
      site = await buildSite(request);
    });

    test("every collapsed group's rows are on the page it names", async () => {
      const navs = new Map<string, ApiNav>();
      const navAt = async (pathname: string) => {
        let nav = navs.get(pathname);
        if (!nav) {
          const { status, body } = await site.get(pathname);
          assert.equal(status, 200, pathname);
          nav = navOf(body);
          navs.set(pathname, nav);
        }
        return nav;
      };
      let checked = 0;
      let fromOverview = 0;
      for (const { full, pages } of versions) {
        for (const page of pages) {
          for (const group of flatten((await navAt(`${BASE}${page}`)).items)) {
            if (!group.deferred) continue;
            assert.ok(group.childrenHref, `${page}: ${group.coordinate} names a page`);
            if (group.childrenHref === toDocumentHref("/api/v1")) fromOverview += 1;
            const there = find((await navAt(`${BASE}${group.childrenHref}`)).items, group.coordinate);
            assert.ok(there && !there.deferred, `${group.childrenHref} lists ${group.coordinate} open`);
            assert.deepEqual(
              there.children.map((c) => c.coordinate),
              find(full.items, group.coordinate)!.children.map((c) => c.coordinate),
            );
            assert.equal(there.children.some((c) => c.active), false, "no highlighted row");
            checked += 1;
          }
        }
      }
      assert.ok(checked > 0);
      assert.ok(fromOverview > 0, "categories load from the v1 overview");
    });

    test("pages carry one build id", async () => {
      const ids = new Set<string | undefined>();
      for (const { pages } of versions) {
        for (const page of pages.slice(0, 3)) ids.add(buildIdOf((await site.get(`${BASE}${page}`)).body));
      }
      assert.equal(ids.size, 1);
      assert.match([...ids][0] ?? "", /^[0-9a-f]{16}$/);
    });
  });
}

describe("outdated starter components", () => {
  const site = async (files: Record<string, string>) => {
    const dir = await mkdtemp(path.join(TEST_TMP, "nimbus-nav-components-"));
    roots.push(dir);
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), contents);
    }
    return dir;
  };
  const item = "components/ui/api-sidebar/ApiSidebarItem.astro";
  const layout = "components/ui/api-layout/ApiLayout.astro";
  const onDemand = [{ collection: "api", sidebar: "on-demand" }];

  test("fail with the command that updates them", async () => {
    const dir = await site({ [item]: "old", [layout]: "data-nb-nav-build={navBuildId}" });
    const error = outdatedApiSidebarError(onDemand, dir, dir);
    assert.match(error ?? "", /ApiSidebarItem\.astro predates it/);
    assert.match(error ?? "", /nimbus-docs add api-layout` and choose Overwrite for api-layout and api-sidebar/);
    assert.match(error ?? "", /registry is older than this project/);
    await writeFile(path.join(dir, "pnpm-lock.yaml"), "");
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ devDependencies: { "@cloudflare/nimbus-docs": "*" } }));
    assert.match(outdatedApiSidebarError(onDemand, dir, dir) ?? "", /`pnpm (exec )?nimbus-docs add api-layout`/, "the site's package manager");
    assert.doesNotMatch(error ?? "", /ApiLayout/);
  });

  test("stay quiet when current, replaced, or not on-demand", async () => {
    const current = await site({ [item]: "item.childrenHref", [layout]: "data-nb-nav-build" });
    assert.equal(outdatedApiSidebarError(onDemand, current, current), undefined);
    assert.equal(outdatedApiSidebarError(onDemand, await site({}), TEST_TMP), undefined);
    const old = await site({ [item]: "old", [layout]: "old" });
    assert.equal(outdatedApiSidebarError([{ collection: "api" }], old, old), undefined);
    assert.match(outdatedApiSidebarError(onDemand, old, old) ?? "", /ApiSidebarItem\.astro and src\/.*ApiLayout\.astro predate it/);
  });

  test("stay quiet when the sidebar panel lives outside ApiLayout", async () => {
    const moved = await site({
      [item]: "item.childrenHref",
      [layout]: "<ApiSidebarPanel nav={nav} version={version} />",
      "components/ui/api-sidebar/ApiSidebarPanel.astro": "data-nb-nav-build={navBuildId}",
    });
    assert.equal(outdatedApiSidebarError(onDemand, moved, moved), undefined);
  });
});

test("the build id changes with what rows are made from, and only then", async () => {
  const dir = await mkdtemp(path.join(TEST_TMP, "nimbus-nav-build-id-"));
  roots.push(dir);
  const src = path.join(dir, "src");
  await mkdir(path.join(src, "components/ui"), { recursive: true });
  await writeFile(path.join(src, "components/ui/Row.astro"), "<li>row</li>");
  const navOfSpec = async (spec: object) =>
    getApiNav(await buildApiModel({ collection: "api", spec: JSON.stringify(spec), mountPath: "/api" }));
  const id = async (spec: object = GROUPED, base = "/") =>
    navBuildId([{ nav: await navOfSpec(spec), sidebar: "on-demand", mountPath: "/api" }], src, base);
  const first = await id();
  assert.equal(await id(), first, "deterministic");
  assert.notEqual(await id(GROUPED, "/docs/"), first, "base");

  const withPath = (pathKey: string, operation: object) => ({
    ...GROUPED,
    paths: { ...GROUPED.paths, [pathKey]: operation },
  });
  const workers = GROUPED.paths["/workers"].get;
  const described = withPath("/workers", {
    get: { ...workers, description: "Edited.", responses: { "200": { description: "edited" } } },
  });
  assert.equal(await id(described), first, "a description edit leaves the rows alone");
  assert.notEqual(await id(withPath("/workers", { get: { ...workers, summary: "Renamed" } })), first, "label");
  assert.notEqual(await id(withPath("/workers", { get: { ...workers, deprecated: true } })), first, "deprecated flag");
  assert.notEqual(
    await id(withPath("/scripts", { post: { operationId: "scriptsCreate", tags: ["Workers"], responses: ok } })),
    first,
    "new operation",
  );

  await writeFile(path.join(src, "components/ui/Row.astro"), "<li class='x'>row</li>");
  const restyled = await id();
  assert.notEqual(restyled, first, "component markup");

  // Components build their classes with helpers such as src/lib/cn.ts.
  await mkdir(path.join(src, "lib"), { recursive: true });
  await writeFile(path.join(src, "lib/cn.ts"), "export const cn = (...c) => c.join(' ');");
  const withHelper = await id();
  assert.notEqual(withHelper, restyled, "helper added");
  await writeFile(path.join(src, "lib/cn.ts"), "export const cn = (...c) => c.filter(Boolean).join(' ');");
  assert.notEqual(await id(), withHelper, "helper edited");
});
