/** Real-adapter acceptance. Install adapters outside the repository and set
 * NIMBUS_TEST_ADAPTER_ROOT to that directory (containing node_modules).
 * This intentionally never replaces real adapters with name-matching mocks. */
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
  realpath,
} from "node:fs/promises";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { build, dev } from "astro";
import nimbus from "../src/index.ts";
import { runningNimbusVersion } from "../src/_internal/upgrades.ts";

const adapterRoot = process.env.NIMBUS_TEST_ADAPTER_ROOT;
const SRC = path.resolve(import.meta.dirname, "../src");
const packageModules = path.resolve(import.meta.dirname, "../node_modules");
const marker = "ASSET_RECORD_ONLY_53_68_description";
const PAGE = `---
import { getApiRoute, getApiStaticPaths, getVersionSwitchUrl, getSidebar, withBase } from "@cloudflare/nimbus-docs/runtime";
import NimbusHead from "@cloudflare/nimbus-docs/components/NimbusHead.astro";
export const prerender = true;
export const getStaticPaths = getApiStaticPaths("api");
const result = await getApiRoute(Astro);
if (result instanceof Response) return result;
const {page,nav,collection,version,coordinate} = result;
const switchUrl = await getVersionSwitchUrl({collection,sourceVersion:version!,id:coordinate,targetVersion:version === "v1" ? "v2" : "v1"});
const sidebar = await getSidebar("");
---
<html><head><NimbusHead title={page.title} collection={collection} apiVersion={version ?? undefined} coordinate={coordinate} markdownUrl={page.markdownHref} /></head>
<body><h1>{page.title}</h1><main data-version={version} data-markdown={page.markdownHref ?? "none"} data-sidebar={JSON.stringify(sidebar)} data-nav={JSON.stringify(nav)}><a class="self" href={withBase(page.href,import.meta.env.BASE_URL)}>{page.title}</a><a class="switch" href={withBase(switchUrl,import.meta.env.BASE_URL)}>switch</a><p>{page.description}</p></main></body></html>`;

function spec(old: boolean) {
  return JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Asset API", version: "1" },
    paths: {
      "/pets": {
        get: {
          operationId: "list-pets",
          summary: "List pets",
          description: marker,
          responses: { "200": { description: "ok" } },
        },
        post: {
          operationId: old ? "make-pet" : "create-pet",
          summary: old ? "Old create" : "New create",
          responses: { "200": { description: "ok" } },
        },
      },
      ...(old
        ? {
            "/legacy": {
              get: {
                operationId: "legacy-report",
                summary: "Legacy only",
                responses: { "200": { description: "ok" } },
              },
            },
          }
        : {}),
    },
  });
}
async function dependencies(root: string) {
  const destination = path.join(root, "node_modules");
  await mkdir(destination, { recursive: true });
  for (const name of await readdir(packageModules)) {
    if (name.startsWith(".")) continue;
    if (!name.startsWith("@"))
      await symlink(
        path.join(packageModules, name),
        path.join(destination, name),
        "dir",
      );
    else {
      await mkdir(path.join(destination, name), { recursive: true });
      for (const child of await readdir(path.join(packageModules, name))) {
        await symlink(
          path.join(packageModules, name, child),
          path.join(destination, name, child),
          "dir",
        );
      }
    }
  }
  for (const name of ["node", "cloudflare"]) {
    await rm(path.join(destination, "@astrojs", name), {
      force: true,
      recursive: true,
    });
    await symlink(
      path.join(adapterRoot!, "node_modules/@astrojs", name),
      path.join(destination, "@astrojs", name),
      "dir",
    );
  }
}
async function fixture(
  t: TestContext,
  worker: boolean,
  extra: Record<string, unknown> = {},
  // A dev server's content sync can outlive server.stop(); removing the
  // folder at exit keeps it from reading deleted files after the test.
  removeAtExit = false,
) {
  // Astro recognises src/live.config.ts by path; macOS's temp folder sits
  // behind a symlink (/var → /private/var), so use the real path.
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "nimbus-assets-adapter-")),
  );
  t.diagnostic(`fixture: ${root}`);
  if (!process.env.NIMBUS_TEST_KEEP && removeAtExit)
    process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  else
    t.after(() =>
      process.env.NIMBUS_TEST_KEEP
        ? undefined
        : rm(root, { recursive: true, force: true, maxRetries: 5 }),
    );
  await dependencies(root);
  const write = async (name: string, contents: string) => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), contents);
  };
  await write("package.json", JSON.stringify({ type: "module" }));
  await write(
    "nimbus.json",
    JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() }),
  );
  await write("specs/v2.json", spec(false));
  await write("specs/v1.json", spec(true));
  await write(
    "specs/core.json",
    JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Static API", version: "1" },
      paths: {
        "/ping": {
          get: {
            operationId: "ping",
            summary: "Static Ping",
            responses: { "200": { description: "ok" } },
          },
        },
      },
    }),
  );
  await write(
    "src/content.config.ts",
    `import {defineCollection} from "astro:content";
import {apiCollection,docsCollection} from ${JSON.stringify(pathToFileURL(path.join(SRC, "content.ts")).href)};
export const collections={docs:defineCollection(docsCollection()),"docs-v1":defineCollection(docsCollection({base:"docs-v1"})),api:defineCollection(apiCollection()),core:defineCollection(apiCollection())};`,
  );
  await write(
    "src/live.config.ts",
    `import { defineLiveCollection } from "astro:content";
import { apiPagesLoader } from "@cloudflare/nimbus-docs/live";
export const collections = { apiPages: defineLiveCollection({ loader: apiPagesLoader() }) };`,
  );
  await write(
    "src/content/docs/guide.md",
    "---\ntitle: Current Guide\n---\nCurrent prose.\n",
  );
  await write(
    "src/content/docs-v1/guide.md",
    "---\ntitle: Old Guide\n---\nHistorical prose.\n",
  );
  const doc = (collection: string) => `---
import {getCollectionStaticPaths,getCollectionPage,getVersionSwitchUrl} from "@cloudflare/nimbus-docs/runtime";
export const prerender=true;
export const getStaticPaths=getCollectionStaticPaths(${JSON.stringify(collection)});
const page=await getCollectionPage(Astro);
if(page instanceof Response)return page;
---
<html><body>Prose ${collection}<h1>{page.entry.data.title}</h1></body></html>`;
  await write("src/pages/[...slug].astro", doc("docs"));
  await write("src/pages/v1/[...slug].astro", doc("docs-v1"));
  await write("src/pages/index.astro", "<html><body>Home</body></html>");
  await write(
    "src/pages/[...slug]/index.md.ts",
    'import {markdownRoute} from "@cloudflare/nimbus-docs/agent-endpoints";export const prerender=true;export const {GET,getStaticPaths}=markdownRoute();',
  );
  await write(
    "src/pages/llms.txt.ts",
    'import {llmsRoute} from "@cloudflare/nimbus-docs/agent-endpoints";export const prerender=true;export const {GET,getStaticPaths}=llmsRoute();',
  );
  await write("src/pages/api/[...slug].astro", PAGE);
  await write(
    "src/pages/core/[...slug].astro",
    `---
import {getApiRoute,getApiStaticPaths} from "@cloudflare/nimbus-docs/runtime";
export const prerender=true;export const getStaticPaths=getApiStaticPaths("core");
const result=await getApiRoute(Astro);if(result instanceof Response)return result;
---
<html><body>{result.page.title}</body></html>`,
  );
  await write(
    "wrangler.jsonc",
    JSON.stringify({
      name: "nimbus-page-assets-test",
      main: "@astrojs/cloudflare/entrypoints/server",
      compatibility_date: "2026-06-01",
      compatibility_flags: ["nodejs_compat"],
      assets: { binding: "ASSETS", directory: "./dist/client" },
    }),
  );
  const adapter = (
    await import(
      pathToFileURL(
        path.join(
          adapterRoot!,
          `node_modules/@astrojs/${worker ? "cloudflare" : "node"}/dist/index.js`,
        ),
      ).href
    )
  ).default;
  const options = {
    root: pathToFileURL(`${root}/`),
    base: worker ? "/" : "/docs",
    cacheDir: path.join(root, ".astro"),
    output: "server",
    logLevel: "warn",
    session: false,
    outDir: path.join(root, "dist"),
    build: {
      client: path.join(root, "dist/client"),
      server: path.join(root, "dist/server"),
    },
    adapter: worker
      ? adapter({
          configPath: path.join(root, "wrangler.jsonc"),
          persistState: false,
          remoteBindings: false,
          inspectorPort: false,
        })
      : adapter({ mode: "standalone" }),
    vite: {
      cacheDir: path.join(root, ".vite"),
      resolve: {
        alias: [
          {
            find: /^@cloudflare\/nimbus-docs$/,
            replacement: path.join(SRC, "index.ts"),
          },
          { find: /^@cloudflare\/nimbus-docs\//, replacement: `${SRC}/` },
        ],
      },
    },
    integrations: [
      nimbus(
        {
          site: "https://example.test",
          title: "Mixed assets",
          search: false,
          versions: { current: "v2", others: ["v1"] },
          rendering: { default: "build", collections: { api: "request" } },
          api: [
            {
              collection: "api",
              versionMode: "query",
              bundle: false,
              versions: [
                { version: "v2", spec: "./specs/v2.json", default: true },
                { version: "v1", spec: "./specs/v1.json" },
              ],
            },
            { collection: "core", spec: "./specs/core.json" },
          ],
        },
        { admonitions: false, sitemap: true, validateMdx: false },
      ),
    ],
  };
  return { root, options: { ...options, ...extra } };
}
async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = path.join(root, entry.name);
    result.push(...(entry.isDirectory() ? await files(name) : [name]));
  }
  return result;
}
function switchHref(html: string) {
  return /class="switch"[^>]*href="([^"]+)"/
    .exec(html)?.[1]
    ?.replaceAll("&amp;", "&");
}
async function assertRequests(
  request: (path: string) => Promise<Response>,
  base = "",
) {
  const latest = await request("/api/list-pets/");
  assert.equal(latest.status, 200);
  const latestHtml = await latest.text();
  assert.match(latestHtml, /data-version="v2"/);
  assert.match(latestHtml, /Current Guide/);
  assert.match(latestHtml, /rel="canonical"/);
  assert.ok(!latestHtml.includes("nimbus-ref:"));
  const old = await request("/api/list-pets/?version=v1");
  assert.equal(old.status, 200);
  const oldHtml = await old.text();
  assert.match(oldHtml, /data-version="v1"/);
  assert.match(oldHtml, /data-markdown="none"/);
  assert.match(oldHtml, /name="robots" content="noindex"/);
  assert.ok(!oldHtml.includes("nimbus-ref:"));
  assert.equal((await request("/api/list-pets/?version=missing")).status, 404);
  assert.equal((await request("/api/legacy-report/")).status, 404);
  assert.equal((await request("/api/legacy-report/?version=v1")).status, 200);
  const switchUrl = switchHref(latestHtml);
  assert.ok(switchUrl);
  const switched = await request(switchUrl);
  assert.equal(switched.status, 302);
  assert.equal(
    switched.headers.get("location"),
    `${base}/api/list-pets/?version=v1`,
  );
  const legacy = await request("/api/list-pets/?api-version=v1");
  assert.equal(legacy.status, 308);
  assert.equal(
    legacy.headers.get("location"),
    `${base}/api/list-pets/?version=v1`,
  );
  const renamed = await request("/api/make-pet/?version=v1");
  assert.equal(renamed.status, 200);
  const renameSwitch = await request(switchHref(await renamed.text())!);
  assert.equal(renameSwitch.headers.get("location"), `${base}/api/create-pet/`);
  assert.equal(
    (await request("/api/list-pets/index.md?version=v1")).status,
    404,
  );
  const markdown = await request("/api/list-pets/index.md");
  assert.equal(markdown.status, 200);
  assert.match(await markdown.text(), /List pets/);
  const llms = await request("/llms.txt");
  assert.equal(llms.status, 200);
  assert.ok(!(await llms.text()).includes("legacy-report"));
}

test(
  "actual Node adapter: relocated mixed site renders asset APIs, resolves switches and keeps historical discovery out",
  { skip: !adapterRoot, timeout: 120_000 },
  async (t) => {
    const { root, options } = await fixture(t, false);
    await build(options as never);
    const serverFiles = (await files(path.join(root, "dist/server"))).filter(
      (file) => /\.(?:m?js|json)$/.test(file),
    );
    for (const file of serverFiles)
      assert.ok(
        !(await readFile(file, "utf8")).includes(marker),
        `page data bundled in ${file}`,
      );
    assert.ok(
      (await readdir(path.join(root, "dist/client/_nimbus/pages"))).some(
        (name) => name.startsWith("index-"),
      ),
    );
    assert.match(
      await readFile(
        path.join(root, "dist/client/core/ping/index.html"),
        "utf8",
      ),
      /Static Ping/,
    );
    const relocated = await mkdtemp(
      path.join(os.tmpdir(), "nimbus-assets-relocated-"),
    );
    t.diagnostic(`relocated: ${relocated}`);
    t.after(() =>
      process.env.NIMBUS_TEST_KEEP
        ? undefined
        : rm(relocated, { recursive: true, force: true, maxRetries: 5 }),
    );
    await cp(path.join(root, "dist"), relocated, { recursive: true });
    await cp(
      path.join(root, "node_modules"),
      path.join(relocated, "node_modules"),
      { recursive: true },
    );
    await rm(path.join(root, ".astro"), { recursive: true, force: true });
    await rm(path.join(root, "dist"), { recursive: true, force: true });
    const oldAuto = process.env.ASTRO_NODE_AUTOSTART;
    process.env.ASTRO_NODE_AUTOSTART = "disabled";
    const { handler } = await import(
      pathToFileURL(path.join(relocated, "server/entry.mjs")).href
    );
    if (oldAuto === undefined) delete process.env.ASTRO_NODE_AUTOSTART;
    else process.env.ASTRO_NODE_AUTOSTART = oldAuto;
    const server = createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await assertRequests(
      (pathname) =>
        fetch(
          `http://127.0.0.1:${address.port}${pathname.startsWith("/docs/") ? pathname : `/docs${pathname}`}`,
          { redirect: "manual" },
        ),
      "/docs",
    );
  },
);

test(
  "actual Node adapter: picker switches stay routable under trailingSlash always",
  { skip: !adapterRoot, timeout: 120_000 },
  async (t) => {
    const { root, options } = await fixture(t, false, {
      base: "/",
      trailingSlash: "always",
    });
    await build(options as never);
    const oldAuto = process.env.ASTRO_NODE_AUTOSTART;
    process.env.ASTRO_NODE_AUTOSTART = "disabled";
    const { handler } = await import(
      pathToFileURL(path.join(root, "dist/server/entry.mjs")).href
    );
    if (oldAuto === undefined) delete process.env.ASTRO_NODE_AUTOSTART;
    else process.env.ASTRO_NODE_AUTOSTART = oldAuto;
    const server = createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const request = (pathname: string) =>
      fetch(`http://127.0.0.1:${address.port}${pathname}`, {
        redirect: "manual",
      });
    const switchUrl = switchHref(
      await (await request("/api/list-pets/")).text(),
    );
    assert.match(switchUrl!, /^\/_nimbus\/version-switch\/\?/);
    const switched = await request(switchUrl!);
    assert.equal(switched.status, 302);
    assert.equal(
      switched.headers.get("location"),
      "/api/list-pets/?version=v1",
    );
  },
);

test(
  "actual Workers adapter: workerd dev serves staged page and agent assets",
  {
    skip: !adapterRoot || process.env.NIMBUS_TEST_WORKER_ASSETS !== "1",
    timeout: 120_000,
  },
  async (t) => {
    // An earlier build in this process leaves NODE_ENV=production, and Astro
    // skips astro:server:setup (Nimbus's spec watcher) for a production Vite.
    const oldNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    t.after(() => {
      if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = oldNodeEnv;
    });
    let server: Awaited<ReturnType<typeof dev>> | undefined;
    t.after(() => server?.stop());
    const { root, options } = await fixture(t, true, {}, true);
    server = await dev({
      ...options,
      server: { host: "127.0.0.1", port: 0 },
    } as never);
    await assertRequests((pathname) =>
      fetch(`http://127.0.0.1:${server!.address.port}${pathname}`, {
        redirect: "manual",
      }),
    );
    const edited = spec(true).replace(
      "Old create",
      "Updated historical create",
    );
    await writeFile(path.join(root, "specs/v1.json"), edited);
    let html = "";
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      html = await (
        await fetch(
          `http://127.0.0.1:${server!.address.port}/api/make-pet/?version=v1`,
        )
      ).text();
      if (html.includes("Updated historical create")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(
      html,
      /Updated historical create/,
      "dev must refresh the version index after a spec edit",
    );
    await server.stop();
    server = undefined;
  },
);

test(
  "actual Workers adapter: production build serves prepared records through ASSETS in local workerd",
  {
    skip: !adapterRoot || process.env.NIMBUS_TEST_WORKER_ASSETS !== "1",
    timeout: 180_000,
  },
  async (t) => {
    let worker:
      | {
          stop(): Promise<void>;
          fetch(path: string, options: unknown): Promise<Response>;
        }
      | undefined;
    t.after(() => worker?.stop());
    const { root, options } = await fixture(t, true);
    await build(options as never);
    const configFiles = (await files(path.join(root, "dist"))).filter((file) =>
      /wrangler\.json$/.test(file),
    );
    assert.equal(
      configFiles.length,
      1,
      "adapter must emit its deployment configuration",
    );
    const configPath = configFiles[0]!;
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const wrangler = await import(
      pathToFileURL(
        path.join(adapterRoot!, "node_modules/wrangler/wrangler-dist/cli.js"),
      ).href
    );
    worker = await wrangler.unstable_dev(
      path.resolve(path.dirname(configPath), config.main),
      {
        config: configPath,
        local: true,
        bundle: false,
        ip: "127.0.0.1",
        port: 0,
        logLevel: "error",
        experimental: {
          disableExperimentalWarning: true,
          disableDevRegistry: true,
        },
      },
    );
    await assertRequests((pathname) =>
      worker!.fetch(pathname, { redirect: "manual" }),
    );
  },
);
