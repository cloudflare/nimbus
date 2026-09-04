import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import sitemap from "@astrojs/sitemap";

import nimbus from "../src/index.js";
import {
  readRequestRouteInventory,
  type NimbusIntegrationOptions,
} from "../src/integration.js";
import {
  canonicalCollectionRouteComponent,
  compileRenderingPolicy,
  normalizeRouteComponent,
  routeComponentKeys,
} from "../src/_internal/rendering-policy.js";
import { getCodeStyleCSS } from "../src/_internal/code-style-registry.js";
import { parseContentCollections } from "../src/_internal/parse-content-collections.js";
import {
  requestInventoryEntryUrl,
  requestInventoryVersionStatusKey,
} from "../src/_internal/request-route-url.js";
import { validateNimbusConfig } from "../src/_internal/validate.js";
import type { NimbusConfig, RenderingConfig } from "../src/types.js";

const baseConfig = (rendering?: RenderingConfig): NimbusConfig => ({
  site: "https://example.test",
  title: "Docs",
  search: false,
  ...(rendering ? { rendering } : {}),
});

test("request inventory preserves prose ids and only collapses the API root", () => {
  assert.equal(requestInventoryEntryUrl("", "index", false), "/index");
  assert.equal(
    requestInventoryEntryUrl("", "guides/index", false),
    "/guides/index",
  );
  assert.equal(
    requestInventoryEntryUrl("/blog", "index", false),
    "/blog/index",
  );
  assert.equal(requestInventoryEntryUrl("/api", "index", true), "/api");
  assert.equal(
    requestInventoryEntryUrl("/api", "guides/index", true),
    "/api/guides/index",
  );
  assert.equal(
    requestInventoryVersionStatusKey("docs-v1", false, "v1"),
    "docs-v1",
  );
  assert.equal(requestInventoryVersionStatusKey("api", true, "v1"), "api@v1");
});

test("request inventory reader removes root and base-prefixed candidates", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "nimbus-request-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rootInventory = path.join(root, "_nimbus/request-route-inventory.json");
  const basedInventory = path.join(
    root,
    "docs/_nimbus/request-route-inventory.json",
  );
  await mkdir(path.dirname(rootInventory), { recursive: true });
  await mkdir(path.dirname(basedInventory), { recursive: true });
  await writeFile(
    rootInventory,
    JSON.stringify([{ collection: "docs", url: "/guide/" }]),
    "utf8",
  );
  await writeFile(basedInventory, "stale", "utf8");

  assert.deepEqual(
    readRequestRouteInventory(root, "/docs/", new Set(["docs"])),
    [
      {
        collection: "docs",
        url: "/guide/",
        request: true,
        discoverable: true,
        searchable: false,
        title: "/guide/",
        language: "en",
      },
    ],
  );
  await assert.rejects(readFile(rootInventory, "utf8"));
  await assert.rejects(readFile(basedInventory, "utf8"));

  await writeFile(
    basedInventory,
    JSON.stringify([{ collection: "docs", url: "/fallback/" }]),
    "utf8",
  );
  assert.equal(
    readRequestRouteInventory(root, "/docs/", new Set(["docs"]))[0]?.url,
    "/fallback/",
  );
  await assert.rejects(readFile(basedInventory, "utf8"));
});

test("request inventory reader removes malformed and invalid-shape files", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "nimbus-request-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inventory = path.join(root, "_nimbus/request-route-inventory.json");
  await mkdir(path.dirname(inventory), { recursive: true });

  await writeFile(inventory, "{", "utf8");
  assert.throws(
    () => readRequestRouteInventory(root, "/", new Set()),
    /request route inventory is invalid/,
  );
  await assert.rejects(readFile(inventory, "utf8"));

  await writeFile(inventory, JSON.stringify([{}]), "utf8");
  assert.throws(
    () => readRequestRouteInventory(root, "/", new Set()),
    /contains an invalid entry/,
  );
  await assert.rejects(readFile(inventory, "utf8"));
});

test("request inventory rejects traversal and symlinked parents", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "nimbus-request-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = path.join(root, "dist");
  const outside = path.join(root, "victim");
  const externalInventory = path.join(
    outside,
    "_nimbus/request-route-inventory.json",
  );
  await mkdir(path.dirname(externalInventory), { recursive: true });
  await writeFile(externalInventory, "external", "utf8");

  assert.throws(
    () => readRequestRouteInventory(dist, "/../victim/", new Set()),
    /escapes the build directory/,
  );
  assert.equal(await readFile(externalInventory, "utf8"), "external");

  await mkdir(dist, { recursive: true });
  try {
    await symlink(
      outside,
      path.join(dist, "docs"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("directory links require elevated privileges");
      return;
    }
    throw err;
  }
  assert.throws(
    () => readRequestRouteInventory(dist, "/docs/", new Set()),
    /parent is not a real directory/,
  );
  assert.equal(await readFile(externalInventory, "utf8"), "external");
});

test("rendering config is optional and validates only build/request modes", () => {
  assert.equal(validateNimbusConfig(baseConfig()).rendering, undefined);
  assert.deepEqual(
    validateNimbusConfig(
      baseConfig({ default: "request", collections: { docs: "build" } }),
    ).rendering,
    { default: "request", collections: { docs: "build" } },
  );

  assert.throws(
    () => validateNimbusConfig(baseConfig({ default: "invalid" as never })),
    /rendering\.default: rendering mode must be either "build" or "request"/,
  );
  assert.throws(
    () =>
      validateNimbusConfig(
        baseConfig({ collections: { docs: "invalid" as never } }),
      ),
    /rendering\.collections\.docs: rendering mode must be either "build" or "request"/,
  );
  assert.throws(
    () =>
      validateNimbusConfig({
        ...baseConfig(),
        rendering: { default: "build", paths: {} },
      }),
    /Unknown rendering sub-key "paths"/,
  );
});

test("compiled policy applies the build default and collection overrides", () => {
  assert.deepEqual(compileRenderingPolicy(undefined, ["docs", "api"]), {
    default: "build",
    collections: { docs: "build", api: "build" },
  });
  assert.deepEqual(
    compileRenderingPolicy(
      { default: "request", collections: { docs: "build" } },
      ["docs", "api"],
    ),
    {
      default: "request",
      collections: { docs: "build", api: "request" },
    },
  );
});

test("compiled policy rejects overrides without canonical collection routes", () => {
  assert.throws(
    () =>
      compileRenderingPolicy({ collections: { typo: "request" } }, ["docs"]),
    /without a registered canonical catch-all route:[\s\S]*"typo"/,
  );
});

test("canonical route keys respect collection mounts and custom srcDir", () => {
  const root = path.join(path.sep, "workspace");
  const srcDir = path.join(root, "app");
  const versions = { others: ["v1"] };

  assert.equal(
    canonicalCollectionRouteComponent(srcDir, "docs", versions),
    path.join(srcDir, "pages", "[...slug].astro"),
  );
  assert.equal(
    canonicalCollectionRouteComponent(srcDir, "docs-v1", versions),
    path.join(srcDir, "pages", "v1", "[...slug].astro"),
  );
  assert.equal(
    canonicalCollectionRouteComponent(srcDir, "api", versions),
    path.join(srcDir, "pages", "api", "[...slug].astro"),
  );
  assert.deepEqual(
    routeComponentKeys(
      root,
      path.join(srcDir, "pages", "api", "[...slug].astro"),
    ),
    [
      normalizeRouteComponent(
        path.join(srcDir, "pages", "api", "[...slug].astro"),
      ),
      "app/pages/api/[...slug].astro",
    ],
  );
});

async function setupIntegration(
  t: TestContext,
  rendering?: RenderingConfig,
  command: "dev" | "build" = "dev",
  contentConfig = 'export const collections = { docs: {}, blog: {}, "docs-v1": {} };\n',
  api?: NimbusConfig["api"],
  integrationOptions: Partial<NimbusIntegrationOptions> = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "nimbus-rendering-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const write = async (relative: string, body: string) => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body, "utf8");
  };
  await write("src/content.config.ts", contentConfig);
  await write("src/components.ts", "export const components = {};\n");
  await write("src/pages/[...slug].astro", "---\n---\n");
  await write("src/pages/blog/[...slug].astro", "---\n---\n");
  await write("src/pages/v1/[...slug].astro", "---\n---\n");
  await write("src/pages/api/[...slug].astro", "---\n---\n");
  await write(
    "src/content/docs/index.mdx",
    "# Docs\n\n```js\nconst requestRendered = true;\n```\n",
  );

  const integration = nimbus(
    {
      ...baseConfig(rendering),
      versions: { current: "v2", others: ["v1"] },
      ...(api ? { api } : {}),
    },
    {
      validateMdx: false,
      admonitions: false,
      sitemap: false,
      markdown: { processor: {} as never },
      ...integrationOptions,
    },
  );
  const setup = integration.hooks["astro:config:setup"];
  assert.ok(setup);
  const configUpdates: Array<Record<string, unknown>> = [];
  const injectedRoutes: unknown[] = [];
  await setup!({
    updateConfig: (update: Record<string, unknown>) => {
      configUpdates.push(update);
      return {} as never;
    },
    injectRoute: (route: unknown) => injectedRoutes.push(route),
    config: {
      root: pathToFileURL(`${root}${path.sep}`),
      srcDir: pathToFileURL(`${path.join(root, "src")}${path.sep}`),
      cacheDir: pathToFileURL(`${path.join(root, ".cache")}${path.sep}`),
      base: "",
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      fork() {
        return this;
      },
    },
    command,
  } as never);

  const routeSetup = integration.hooks["astro:route:setup"];
  const configDone = integration.hooks["astro:config:done"];
  const routesResolved = integration.hooks["astro:routes:resolved"];
  const serverSetup = integration.hooks["astro:server:setup"];
  const buildStart = integration.hooks["astro:build:start"];
  const buildDone = integration.hooks["astro:build:done"];
  assert.ok(routeSetup);
  assert.ok(configDone);
  assert.ok(routesResolved);
  assert.ok(serverSetup);
  assert.ok(buildStart);
  assert.ok(buildDone);
  return {
    root,
    configUpdates,
    injectedRoutes,
    routeSetup: routeSetup!,
    configDone: configDone!,
    routesResolved: routesResolved!,
    serverSetup: serverSetup!,
    buildStart: buildStart!,
    buildDone: buildDone!,
  };
}

const buildLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fork() {
    return this;
  },
};

async function generateRequestSitemap(
  t: TestContext,
  entries: readonly Record<string, unknown>[],
  pages: readonly { pathname: string }[],
  sitemapOptions: NonNullable<NimbusIntegrationOptions["sitemap"]> = {},
) {
  const integration = await setupIntegration(
    t,
    { collections: { docs: "request" } },
    "build",
    undefined,
    undefined,
    { sitemap: sitemapOptions },
  );
  await integration.routeSetup({
    route: { component: "src/pages/[...slug].astro", prerender: true },
  } as never);
  integration.configDone({
    injectTypes: () => new URL("file:///noop"),
    config: { output: "server", adapter: { name: "cloudflare" } },
    buildOutput: "server",
  } as never);
  const routes = [
    {
      pattern: "/[...slug]",
      entrypoint: "src/pages/[...slug].astro",
      type: "page",
      isPrerendered: false,
      origin: "project",
    },
  ];
  integration.routesResolved({ routes } as never);

  const sitemapIntegration = integration.configUpdates
    .flatMap(
      (update) =>
        (update.integrations as
          | Array<{
              name: string;
              hooks: Record<string, (...args: never[]) => unknown>;
            }>
          | undefined) ?? [],
    )
    .find((candidate) => candidate.name === "@astrojs/sitemap");
  assert.ok(sitemapIntegration);
  await sitemapIntegration.hooks["astro:config:done"]?.({
    config: {
      site: "https://example.test",
      base: "/",
      trailingSlash: "ignore",
      build: { format: "directory" },
    },
  } as never);
  await sitemapIntegration.hooks["astro:routes:resolved"]?.({
    routes: [],
  } as never);

  const dist = path.join(integration.root, "dist");
  await mkdir(path.join(dist, "_nimbus"), { recursive: true });
  await writeFile(
    path.join(dist, "_nimbus/request-route-inventory.json"),
    JSON.stringify(entries),
    "utf8",
  );
  const emittedPages = [
    ...pages,
    { pathname: "/_nimbus/request-route-inventory.json" },
  ];
  await integration.buildDone({
    dir: pathToFileURL(`${dist}${path.sep}`),
    pages: emittedPages,
    logger: buildLogger,
  } as never);
  await sitemapIntegration.hooks["astro:build:done"]?.({
    dir: pathToFileURL(`${dist}${path.sep}`),
    pages: emittedPages,
    logger: buildLogger,
  } as never);
  return readFile(path.join(dist, "sitemap-0.xml"), "utf8");
}

test("request-only sitemap uses upstream filtering, serialization, and deduplication", async (t) => {
  const serialized: string[] = [];
  const xml = await generateRequestSitemap(
    t,
    [
      { collection: "docs", url: "/runtime/", discoverable: true },
      { collection: "docs", url: "/runtime/", discoverable: true },
      { collection: "docs", url: "/private/", discoverable: false },
    ],
    [],
    {
      serialize: ({ url }) => {
        serialized.push(url);
        return { url, changefreq: "daily", priority: 0.7 };
      },
    },
  );

  assert.deepEqual(serialized, ["https://example.test/runtime/"]);
  assert.equal(
    xml.match(/<loc>https:\/\/example\.test\/runtime\/<\/loc>/g)?.length,
    1,
  );
  assert.doesNotMatch(xml, /private|request-route-inventory/);
  assert.match(xml, /<changefreq>daily<\/changefreq>/);
  assert.match(xml, /<priority>0\.7<\/priority>/);
});

test("mixed sitemap includes prerendered and request-rendered pages", async (t) => {
  const xml = await generateRequestSitemap(
    t,
    [{ collection: "docs", url: "/runtime/" }],
    [{ pathname: "/built/" }],
  );

  assert.match(xml, /<loc>https:\/\/example\.test\/built\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/example\.test\/runtime\/<\/loc>/);
});

test("sitemap accepts custom page inventories above the argument limit", async (t) => {
  const customPages = Array.from(
    { length: 130_000 },
    (_, index) => `https://example.test/custom-${index}/`,
  );

  await assert.doesNotReject(() =>
    setupIntegration(t, undefined, "dev", undefined, undefined, {
      sitemap: { customPages },
    }),
  );
});

test("upstream sitemap chunks request pages read from a mutable customPages array", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "nimbus-sitemap-chunks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const customPages: string[] = [];
  const integration = sitemap({ customPages, entryLimit: 2 });
  await integration.hooks["astro:config:done"]?.({
    config: {
      site: "https://example.test",
      base: "/",
      trailingSlash: "ignore",
      build: { format: "directory" },
    },
  } as never);
  await integration.hooks["astro:routes:resolved"]?.({ routes: [] } as never);

  customPages.push(
    "https://example.test/runtime-1/",
    "https://example.test/runtime-2/",
    "https://example.test/runtime-2/",
    "https://example.test/runtime-3/",
    "https://example.test/runtime-4/",
  );
  await integration.hooks["astro:build:done"]?.({
    dir: pathToFileURL(`${root}${path.sep}`),
    pages: [{ pathname: "/built/" }],
    logger: buildLogger,
  } as never);

  const files = (await readdir(root))
    .filter((file) => /^sitemap-\d+\.xml$/.test(file))
    .sort();
  assert.equal(files.length, 3);
  const chunks = await Promise.all(
    files.map((file) => readFile(path.join(root, file), "utf8")),
  );
  assert.equal(
    chunks.reduce(
      (count, xml) => count + (xml.match(/<url>/g)?.length ?? 0),
      0,
    ),
    5,
  );
  assert.ok(chunks.every((xml) => (xml.match(/<url>/g)?.length ?? 0) <= 2));
  assert.match(
    await readFile(path.join(root, "sitemap-index.xml"), "utf8"),
    /sitemap-2\.xml/,
  );
});

test("request inventory is removed before downstream build failures", async (t) => {
  const integration = await setupIntegration(
    t,
    { collections: { docs: "request" } },
    "build",
  );
  integration.configDone({
    injectTypes: () => new URL("file:///noop"),
    config: { output: "server", adapter: { name: "cloudflare" } },
    buildOutput: "server",
  } as never);
  integration.routesResolved({ routes: [] } as never);
  const dist = path.join(integration.root, "dist");
  const inventory = path.join(dist, "_nimbus/request-route-inventory.json");
  await mkdir(path.dirname(inventory), { recursive: true });
  await writeFile(
    inventory,
    JSON.stringify([{ collection: "docs", url: "/guide/" }]),
    "utf8",
  );

  await assert.rejects(
    integration.buildDone({
      dir: pathToFileURL(`${dist}${path.sep}`),
      pages: [{ pathname: "/_nimbus/request-route-inventory.json" }],
      logger: buildLogger,
    } as never),
  );
  await assert.rejects(readFile(inventory, "utf8"));
});

test("route policy independently selects canonical collection catch-alls", async (t) => {
  const { routeSetup } = await setupIntegration(t, {
    default: "request",
    collections: { docs: "build" },
  });
  const docs = { component: "src/pages/[...slug].astro", prerender: false };
  const blog = { component: "src/pages/blog/[...slug].astro", prerender: true };
  const version = {
    component: "src/pages/v1/[...slug].astro",
    prerender: true,
  };
  const nearMatch = {
    component: "src/pages/blog/[...path].astro",
    prerender: true,
  };

  await routeSetup({ route: docs } as never);
  await routeSetup({ route: blog } as never);
  await routeSetup({ route: version } as never);
  await routeSetup({ route: nearMatch } as never);

  assert.equal(docs.prerender, true);
  assert.equal(blog.prerender, false);
  assert.equal(version.prerender, false);
  assert.equal(nearMatch.prerender, true);
});

test("omitted rendering policy leaves existing route decisions untouched", async (t) => {
  const integration = await setupIntegration(t, undefined, "build");
  const docs = { component: "src/pages/[...slug].astro", prerender: false };
  const blog = { component: "src/pages/blog/[...slug].astro", prerender: true };

  await integration.routeSetup({ route: docs } as never);
  await integration.routeSetup({ route: blog } as never);

  assert.equal(docs.prerender, false);
  assert.equal(blog.prerender, true);
  assert.equal(integration.injectedRoutes.length, 0);

  integration.configDone({
    injectTypes: () => new URL("file:///noop"),
    config: { output: "static" },
    buildOutput: "static",
  } as never);
  integration.routesResolved({ routes: [] } as never);
  await integration.buildDone({
    dir: pathToFileURL(`${path.join(integration.root, "dist")}${path.sep}`),
    pages: [{ pathname: "/_nimbus/request-route-inventory.json" }],
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      fork() {
        return this;
      },
    },
  } as never);
  const routeTruth = JSON.parse(
    await readFile(path.join(integration.root, ".nimbus/routes.json"), "utf8"),
  );
  assert.deepEqual(routeTruth.knownRoutes, [
    "/_nimbus/request-route-inventory.json",
  ]);
});

test("opaque version registrations still reach the request inventory", async (t) => {
  const integration = await setupIntegration(
    t,
    { collections: { "docs-v1": "request" } },
    "build",
    "const collections = makeCollections(); export { collections };\n",
  );
  const plugins = integration.configUpdates.flatMap(
    (update) =>
      (update.vite as { plugins?: unknown[] } | undefined)?.plugins ?? [],
  ) as Array<{
    name?: string;
    resolveId?(id: string): string | undefined;
    load?(id: string): string | undefined;
  }>;
  const virtualConfig = plugins.find(
    (plugin) => plugin.name === "nimbus-docs:virtual-config",
  );
  assert.ok(virtualConfig?.resolveId && virtualConfig.load);
  const resolved = virtualConfig.resolveId("virtual:nimbus/config");
  assert.ok(resolved);
  assert.match(
    virtualConfig.load(resolved) ?? "",
    /requestRenderingCollections = \["docs-v1"\]/,
  );
  assert.match(
    virtualConfig.load(resolved) ?? "",
    /indexedCollections = \["docs","docs-v1"\]/,
  );
});

test("an explicitly empty rendering policy applies the build default", async (t) => {
  const { routeSetup } = await setupIntegration(t, {});
  const docs = { component: "src/pages/[...slug].astro", prerender: false };
  const blog = {
    component: "src/pages/blog/[...slug].astro",
    prerender: false,
  };

  await routeSetup({ route: docs } as never);
  await routeSetup({ route: blog } as never);

  assert.equal(docs.prerender, true);
  assert.equal(blog.prerender, true);
});

test("production request rendering requires server output and an adapter", async (t) => {
  const staticBuild = await setupIntegration(
    t,
    { collections: { docs: "request" } },
    "build",
  );
  assert.throws(
    () =>
      staticBuild.configDone({
        injectTypes: () => new URL("file:///noop"),
        config: { output: "static", adapter: null },
        buildOutput: "static",
      } as never),
    /requires Astro `output: "server"` and a compatible adapter.*output=static, adapter=none/,
  );

  const adapterlessBuild = await setupIntegration(
    t,
    { collections: { docs: "request" } },
    "build",
  );
  assert.throws(
    () =>
      adapterlessBuild.configDone({
        injectTypes: () => new URL("file:///noop"),
        config: { output: "server", adapter: null },
        buildOutput: "server",
      } as never),
    /output=server, adapter=none/,
  );

  const serverBuild = await setupIntegration(
    t,
    { collections: { docs: "request" } },
    "build",
  );
  assert.doesNotThrow(() =>
    serverBuild.configDone({
      injectTypes: () => new URL("file:///noop"),
      config: { output: "server", adapter: { name: "cloudflare" } },
      buildOutput: "server",
    } as never),
  );

  assert.throws(
    () =>
      serverBuild.configDone({
        injectTypes: () => new URL("file:///noop"),
        config: { output: "server", adapter: { name: "node" } },
        buildOutput: "server",
      } as never),
    /currently requires `@astrojs\/cloudflare`/,
  );
});

test("production API request rendering is accepted with model packaging", async (t) => {
  const integration = await setupIntegration(
    t,
    { collections: { api: "request" } },
    "build",
    'export const collections = { docs: {}, "docs-v1": {}, api: {} };\n',
    [
      {
        collection: "api",
        spec: {
          openapi: "3.1.0",
          info: { title: "API", version: "1" },
          paths: {
            "/ping": {
              get: {
                operationId: "ping",
                responses: { "200": { description: "OK" } },
              },
            },
          },
        },
      },
    ],
  );
  assert.doesNotThrow(() =>
    integration.configDone({
      injectTypes: () => new URL("file:///noop"),
      config: { output: "server", adapter: { name: "cloudflare" } },
      buildOutput: "server",
    } as never),
  );
});

test("configured request routes are explained to the build invariant", async (t) => {
  const integration = await setupIntegration(
    t,
    { collections: { docs: "request" } },
    "build",
  );
  const route = {
    component: "src/pages/[...slug].astro",
    prerender: true,
  };
  await integration.routeSetup({ route } as never);
  integration.configDone({
    injectTypes: () => new URL("file:///noop"),
    config: { output: "server", adapter: { name: "cloudflare" } },
    buildOutput: "server",
  } as never);
  integration.routesResolved({
    routes: [
      {
        pattern: "/[...slug]",
        entrypoint: "src/pages/[...slug].astro",
        type: "page",
        isPrerendered: false,
        origin: "project",
      },
    ],
  } as never);
  await integration.buildStart({} as never);

  const dist = path.join(integration.root, "dist");
  await mkdir(path.join(dist, "_nimbus"), { recursive: true });
  await writeFile(
    path.join(dist, "_nimbus/request-route-inventory.json"),
    JSON.stringify([
      { collection: "docs", url: "/guide/" },
      { collection: "docs", url: "/built/" },
      { collection: "blog", url: "/blog/post/" },
    ]),
    "utf8",
  );
  const infos: string[] = [];
  await assert.doesNotReject(() =>
    integration.buildDone({
      dir: pathToFileURL(`${dist}${path.sep}`),
      pages: [
        { pathname: "/built" },
        { pathname: "/foo/_nimbus/request-route-inventory.json" },
        { pathname: "/_nimbus/request-route-inventory.json" },
      ],
      logger: {
        info: (message: string) => infos.push(message),
        warn: () => {},
        error: () => {},
        debug: () => {},
        fork() {
          return this;
        },
      },
    } as never),
  );
  assert.equal(route.prerender, false);
  assert.ok(
    infos.some((message) => /docs prerendered=2\/3 \(1 moved\)/.test(message)),
  );
  const routeTruth = JSON.parse(
    await readFile(path.join(integration.root, ".nimbus/routes.json"), "utf8"),
  );
  assert.equal(routeTruth.version, 2);
  assert.deepEqual(routeTruth.sourceFingerprint, {
    version: 1,
    algorithm: "sha256",
    digest: routeTruth.sourceFingerprint.digest,
  });
  assert.match(routeTruth.sourceFingerprint.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(routeTruth.knownRoutes, [
    "/built",
    "/foo/_nimbus/request-route-inventory.json",
    "/guide",
  ]);
  assert.deepEqual(routeTruth.opaqueNamespaces, []);
  assert.equal(
    integration.injectedRoutes.some(
      (candidate) =>
        (candidate as { pattern?: string }).pattern ===
        "/_nimbus/request-route-inventory.json",
    ),
    true,
  );
  await assert.rejects(() =>
    readFile(path.join(dist, "_nimbus/request-route-inventory.json"), "utf8"),
  );
  assert.match(
    await readFile(path.join(dist, "_nimbus/shiki.css"), "utf8"),
    /\.nb-shiki-/,
  );
});

test("production build start invalidates old route truth and failed builds do not restore it", async (t) => {
  const integration = await setupIntegration(t, undefined, "build");
  integration.configDone({
    injectTypes: () => new URL("file:///noop"),
    config: { output: "server", adapter: { name: "node" } },
    buildOutput: "server",
  } as never);
  integration.routesResolved({ routes: [] } as never);

  const manifest = path.join(integration.root, ".nimbus/routes.json");
  await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(manifest, '{"version":1}\n', "utf8");
  await integration.buildStart({} as never);
  await assert.rejects(() => readFile(manifest, "utf8"), /ENOENT/);

  await assert.rejects(
    () =>
      integration.buildDone({
        dir: pathToFileURL(`${path.join(integration.root, "dist")}${path.sep}`),
        pages: [{ pathname: "/" }],
        logger: buildLogger,
      } as never),
    /CANNOT BE VERIFIED/,
  );
  await assert.rejects(() => readFile(manifest, "utf8"), /ENOENT/);
});

test("a source change during a production build leaves route truth invalidated", async (t) => {
  const integration = await setupIntegration(t, undefined, "build");
  integration.configDone({
    injectTypes: () => new URL("file:///noop"),
    config: { output: "static", adapter: undefined },
    buildOutput: "static",
  } as never);
  integration.routesResolved({
    routes: [
      {
        pattern: "/",
        entrypoint: "src/pages/[...slug].astro",
        type: "page",
        isPrerendered: true,
        origin: "project",
      },
    ],
  } as never);
  await integration.buildStart({} as never);
  await mkdir(path.join(integration.root, "src/data"), { recursive: true });
  await writeFile(
    path.join(integration.root, "src/data/routes.json"),
    '["/new"]\n',
    "utf8",
  );
  const dist = path.join(integration.root, "dist");
  await mkdir(dist, { recursive: true });
  await integration.buildDone({
    dir: pathToFileURL(`${dist}${path.sep}`),
    pages: [{ pathname: "/" }],
    logger: buildLogger,
  } as never);
  await assert.rejects(
    () => readFile(path.join(integration.root, ".nimbus/routes.json"), "utf8"),
    /ENOENT/,
  );
});

test("dev setup preserves pre-registered request styles", async (t) => {
  const integration = await setupIntegration(t, {
    collections: { docs: "request" },
  });
  assert.match(getCodeStyleCSS(), /\.nb-shiki-/);
  await integration.serverSetup({
    server: {
      middlewares: { use: () => {} },
      watcher: { on: () => {} },
      config: { logger: { error: () => {} } },
    },
  } as never);
  assert.match(getCodeStyleCSS(), /\.nb-shiki-/);
});

test("collection parsing reports whether registrations are complete", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "nimbus-collection-parse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "content.config.ts");

  await writeFile(file, "export const collections = { docs: {}, blog: {} };\n");
  assert.deepEqual(await parseContentCollections(file), {
    names: ["docs", "blog"],
    complete: true,
  });

  await writeFile(
    file,
    "export const collections = { docs: {}, ...extras, [name]: value };\n",
  );
  assert.deepEqual(await parseContentCollections(file), {
    names: ["docs"],
    complete: false,
  });

  await writeFile(file, "const all = {}; export { all as collections };\n");
  assert.deepEqual(await parseContentCollections(file), {
    names: [],
    complete: false,
  });

  await writeFile(
    file,
    "export const collections = { docs: {} }; collections.blog = {};\n",
  );
  assert.deepEqual(await parseContentCollections(file), {
    names: ["docs"],
    complete: false,
  });

  await writeFile(
    file,
    "export const collections = { docs: {} }; type Name = keyof typeof collections;\n",
  );
  assert.deepEqual(await parseContentCollections(file), {
    names: ["docs"],
    complete: true,
  });
});

test("opaque registrations cannot silently absorb request policy", async (t) => {
  const contentConfig =
    'const extras = {}; export const collections = { docs: {}, "docs-v1": {}, ...extras };\n';
  await assert.rejects(
    () => setupIntegration(t, { default: "request" }, "build", contentConfig),
    /cannot safely enumerate collections.*cannot identify statically/,
  );
  await assert.rejects(
    () =>
      setupIntegration(
        t,
        { default: "request" },
        "build",
        "const all = {}; export { all as collections };\n",
      ),
    /cannot safely enumerate collections.*cannot identify statically/,
  );
  await assert.rejects(
    () =>
      setupIntegration(
        t,
        { collections: { blog: "request" } },
        "build",
        contentConfig,
      ),
    /cannot safely enumerate collections.*cannot identify statically/,
  );

  const knownOverride = await setupIntegration(
    t,
    { collections: { docs: "request" } },
    "build",
    contentConfig,
  );
  const docs = { component: "src/pages/[...slug].astro", prerender: true };
  await knownOverride.routeSetup({ route: docs } as never);
  assert.equal(docs.prerender, false);
  const injected = knownOverride.injectedRoutes[0] as {
    entrypoint: URL;
  };
  assert.equal(injected.entrypoint.protocol, "file:");
  assert.match(injected.entrypoint.pathname, /request-route-inventory\.ts$/);
});
