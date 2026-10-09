/** Full starter API renderer through real adapters. No deploy or repository mutation.
 * NIMBUS_TEST_ADAPTER_ROOT must hold @astrojs/cloudflare, wrangler and ws in its
 * node_modules (ws profiles through the inspector; Node's WebSocket can't connect).
 * NIMBUS_TEST_ADAPTER_ROOT=/tmp/nimbus-page-assets-adapters node --import tsx scripts/api-page-assets-adapter-benchmark.mts --spec /path/to/spec.json --root /tmp/nimbus-page-assets-full-renderer --report /tmp/full-renderer.json --keep
 * --versions N uses identical retained snapshots to isolate request-path costs;
 * it is NOT a churn/full-rebuild capacity benchmark. --sidebar full measures the
 * default full tree; the default here is explicitly on-demand navigation.
 */
import { build } from "astro";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  statfs,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import nimbus from "../src/index.ts";
import { runningNimbusVersion } from "../src/_internal/upgrades.ts";
const args = process.argv.slice(2),
  arg = (key: string) => {
    const i = args.indexOf(key);
    return i < 0 ? undefined : args[i + 1];
  };
const root = path.resolve(
  arg("--root") ?? "/tmp/nimbus-page-assets-full-renderer",
);
const reportPath = path.resolve(
  arg("--report") ?? "/tmp/nimbus-full-renderer-report.json",
);
const adapterRoot = process.env.NIMBUS_TEST_ADAPTER_ROOT;
if (!adapterRoot)
  throw new Error(
    "Set NIMBUS_TEST_ADAPTER_ROOT to separately installed real adapters.",
  );
const sourceDir = fileURLToPath(new URL("../src/", import.meta.url));
const starter = fileURLToPath(
  new URL("../../nimbus-starter-source/", import.meta.url),
);
const versionCount = Number(arg("--versions") ?? 1);
const mode = arg("--adapter") ?? "workers";
const sidebar = arg("--sidebar") ?? "on-demand";
if (!Number.isSafeInteger(versionCount) || versionCount < 1)
  throw new Error("Invalid --versions");
if (mode !== "workers")
  throw new Error("This harness currently measures the Workers lane.");
if (sidebar !== "on-demand" && sidebar !== "full")
  throw new Error("Invalid --sidebar");
const owned = path.join(root, ".nimbus-benchmark-owned");
if (existsSync(root) && !existsSync(owned))
  throw new Error("Refusing to reuse a directory this benchmark does not own.");
await mkdir(root, { recursive: true });
await writeFile(owned, "Nimbus staged page full renderer benchmark\n");
const free = await statfs(root);
if (free.bavail * free.bsize < 2 * 1024 ** 3)
  throw new Error("Need at least 2 GiB free for this single-spec benchmark.");
async function write(filename: string, body: string) {
  const target = path.join(root, filename);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
}
async function linkModules(source: string) {
  const destination = path.join(root, "node_modules");
  await mkdir(destination, { recursive: true });
  for (const name of await readdir(source)) {
    if (name.startsWith(".")) continue;
    if (!name.startsWith("@")) {
      if (!existsSync(path.join(destination, name)))
        await symlink(
          path.join(source, name),
          path.join(destination, name),
          "dir",
        );
    } else {
      await mkdir(path.join(destination, name), { recursive: true });
      for (const child of await readdir(path.join(source, name)))
        if (!existsSync(path.join(destination, name, child)))
          await symlink(
            path.join(source, name, child),
            path.join(destination, name, child),
            "dir",
          );
    }
  }
}
await linkModules(fileURLToPath(new URL("../node_modules/", import.meta.url)));
await linkModules(path.join(starter, "node_modules"));
await mkdir(path.join(root, "node_modules/@astrojs"), { recursive: true });
for (const adapter of ["node", "cloudflare"]) {
  const target = path.join(root, "node_modules/@astrojs", adapter);
  if (!existsSync(target))
    await symlink(
      path.join(adapterRoot, "node_modules/@astrojs", adapter),
      target,
      "dir",
    );
}
await cp(
  path.join(starter, "src/components"),
  path.join(root, "src/components"),
  { recursive: true },
);
await cp(path.join(starter, "src/lib"), path.join(root, "src/lib"), {
  recursive: true,
});
// Nimbus finds icon sets in the site's declared @iconify-json/* dependencies.
const starterPackage = JSON.parse(
  await readFile(path.join(starter, "package.json"), "utf8"),
);
await write(
  "package.json",
  JSON.stringify({
    type: "module",
    dependencies: Object.fromEntries(
      Object.entries(starterPackage.dependencies ?? {}).filter(([name]) =>
        name.startsWith("@iconify-json/"),
      ),
    ),
  }),
);
await write(
  "tsconfig.json",
  JSON.stringify({
    extends: "astro/tsconfigs/strict",
    compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
  }),
);
await write(
  "nimbus.json",
  JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() }),
);
const synthetic = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Full renderer pilot", version: "1" },
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "List pets",
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { name: { type: "string" } },
                },
                example: { name: "Milo" },
              },
            },
          },
        },
      },
    },
  },
});
const input = arg("--spec")
  ? await readFile(path.resolve(arg("--spec")!), "utf8")
  : synthetic;
const spec = JSON.parse(input);
const methods = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
]);
const operations = Object.values(spec.paths ?? {}).reduce(
  (count: number, item: any) =>
    count + Object.keys(item).filter((key) => methods.has(key)).length,
  0,
);
await write("spec.json", input);
await write(
  "src/content.config.ts",
  `import {defineCollection} from "astro:content";import {apiCollection,docsCollection} from ${JSON.stringify(pathToFileURL(path.join(sourceDir, "content.ts")).href)};export const collections={docs:defineCollection(docsCollection()),api:defineCollection(apiCollection())};`,
);
await write("src/live.config.ts", `import { defineLiveCollection } from "astro:content";
import { apiPagesLoader } from "@cloudflare/nimbus-docs/live";
export const collections = { apiPages: defineLiveCollection({ loader: apiPagesLoader() }) };`);
await write(
  "src/content/docs/guide.md",
  "---\ntitle: Guide\n---\nSmall prose collection beside the API.\n",
);
await write(
  "src/pages/[...slug].astro",
  `---\nimport {getDocsStaticPaths,getDocsPage} from "@cloudflare/nimbus-docs/runtime";export const prerender=true;export const getStaticPaths=getDocsStaticPaths;const page=await getDocsPage(Astro);if(page instanceof Response)return page;\n---\n<html><body>{page.entry.data.title}</body></html>`,
);
await write(
  "src/pages/index.astro",
  "<html><body>Reference benchmark</body></html>",
);
await write(
  "src/pages/[...slug]/index.md.ts",
  'import {markdownRoute} from "@cloudflare/nimbus-docs/agent-endpoints";export const prerender=true;export const {GET,getStaticPaths}=markdownRoute();',
);
await write(
  "src/pages/llms.txt.ts",
  'import {llmsRoute} from "@cloudflare/nimbus-docs/agent-endpoints";export const prerender=true;export const {GET}=llmsRoute();',
);
await write(
  "src/pages/api/[...slug].astro",
  `---
import {getApiRoute,getApiStaticPaths} from "@cloudflare/nimbus-docs/runtime";
import NimbusHead from "@cloudflare/nimbus-docs/components/NimbusHead.astro";
import ApiLayout from "@/components/ui/api-layout/ApiLayout.astro";
import VersionSwitcher from "@/components/ui/version-switcher/VersionSwitcher.astro";
export const prerender=true;export const getStaticPaths=getApiStaticPaths("api");
const result=await getApiRoute(Astro);if(result instanceof Response)return result;
const {page,nav,collection,version,coordinate}=result;
---
<html><head><NimbusHead title={page.title} collection={collection} apiVersion={version??undefined} coordinate={coordinate} markdownUrl={page.markdownHref}/></head><body><VersionSwitcher apiCollection={collection} apiVersion={version??undefined} coordinate={coordinate}/><ApiLayout page={page} nav={nav} collection={collection} version={version} coordinate={coordinate}/></body></html>`,
);
await write(
  "wrangler.jsonc",
  JSON.stringify({
    name: "nimbus-full-renderer-benchmark",
    main: "@astrojs/cloudflare/entrypoints/server",
    compatibility_date: "2026-06-01",
    compatibility_flags: ["nodejs_compat"],
    assets: { binding: "ASSETS", directory: "./dist/client" },
  }),
);
const adapter = (
  await import(
    pathToFileURL(
      path.join(adapterRoot, "node_modules/@astrojs/cloudflare/dist/index.js"),
    ).href
  )
).default;
const versions = Array.from({ length: versionCount }, (_, i) => ({
  version: `v${String(versionCount - i).padStart(3, "0")}`,
  spec: "./spec.json",
  ...(i === 0 ? { default: true } : {}),
}));
const report: any = {
  date: new Date().toISOString(),
  scope:
    "local workerd full starter renderer; identical snapshots isolate request costs, not churn capacity",
  root,
  input: {
    path: arg("--spec") ?? "synthetic",
    sha256: createHash("sha256").update(input).digest("hex"),
    bytes: Buffer.byteLength(input),
    operations,
  },
  configuration: {
    versions: versionCount,
    sidebar,
    schemaPages: false,
    samples: ["curl"],
    search: true,
  },
  phases: {},
  requests: [],
};
let worker: any, ws: any;
try {
  const start = performance.now(),
    cpu = process.cpuUsage();
  await build({
    root: pathToFileURL(root + "/"),
    cacheDir: path.join(root, ".astro"),
    outDir: path.join(root, "dist"),
    build: {
      client: path.join(root, "dist/client"),
      server: path.join(root, "dist/server"),
    },
    output: "server",
    session: false,
    logLevel: "warn",
    adapter: adapter({
      configPath: path.join(root, "wrangler.jsonc"),
      persistState: false,
      remoteBindings: false,
      inspectorPort: false,
    }),
    vite: {
      resolve: {
        alias: [
          {
            find: /^@cloudflare\/nimbus-docs$/,
            replacement: path.join(sourceDir, "index.ts"),
          },
          { find: /^@cloudflare\/nimbus-docs\//, replacement: sourceDir + "/" },
          { find: "@", replacement: path.join(root, "src") },
        ],
      },
      cacheDir: path.join(root, ".vite"),
    },
    integrations: [
      nimbus(
        {
          site: "https://example.test",
          title: "Full API renderer",
          rendering: { default: "build", collections: { api: "request" } },
          api: [
            {
              collection: "api",
              versionUrl: { in: "query" },
              bundle: false,
              sidebar,
              schemaPages: false,
              samples: { generate: ["curl"] },
              versions,
            },
          ],
        },
        { admonitions: false, sitemap: true, validateMdx: false },
      ),
    ],
  } as never);
  report.phases.build = {
    wallMs: performance.now() - start,
    nodeCpu: process.cpuUsage(cpu),
    nodeMaxRSSKiB: process.resourceUsage().maxRSS,
  };
  async function inventory(
    directory: string,
  ): Promise<Array<{ file: string; bytes: number }>> {
    const items = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) items.push(...(await inventory(file)));
      else if (entry.isFile())
        items.push({
          file: path.relative(root, file),
          bytes: (await stat(file)).size,
        });
    }
    return items;
  }
  const client = await inventory(path.join(root, "dist/client")),
    server = await inventory(path.join(root, "dist/server"));
  const summarize = (files: Array<{ file: string; bytes: number }>) => ({
    files: files.length,
    bytes: files.reduce((n, file) => n + file.bytes, 0),
    largest: [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 12),
    over25MiB: files.filter((file) => file.bytes > 25 * 1024 * 1024),
  });
  report.outputs = {
    client: summarize(client),
    server: summarize(server),
    agent: summarize(
      client.filter((file) =>
        /agent-endpoint-assets|llms|index\.md/.test(file.file),
      ),
    ),
    search: summarize(
      client.filter((file) => /pagefind|search/.test(file.file)),
    ),
  };
  const { getApiPageAssetManifest } = await import(
    pathToFileURL(path.join(sourceDir, "_internal/api/page-assets-build.ts"))
      .href
  );
  const manifest = getApiPageAssetManifest(root);
  const latestIndex = JSON.parse(
    await readFile(
      path.join(
        root,
        "dist/client/_nimbus/pages",
        manifest.api[versions[0]!.version],
      ),
      "utf8",
    ),
  );
  const navigation = JSON.stringify(latestIndex.metadata.nav);
  report.navigation = {
    bytes: Buffer.byteLength(navigation),
    gzipBytes: gzipSync(navigation).length,
  };
  const pageDirectory = path.join(root, "dist/client/_nimbus/pages");
  const candidates = [];
  const packs = new Map<string, any>();
  for (const row of latestIndex.rows) {
    let contents = packs.get(row.location.filename);
    if (!contents) {
      contents = JSON.parse(
        await readFile(path.join(pageDirectory, row.location.filename), "utf8"),
      );
      packs.set(row.location.filename, contents);
    }
    const record = row.location.key
      ? contents.records[row.location.key]
      : contents;
    if (record.kind === "operation")
      candidates.push({
        id: row.id,
        slug: row.slug,
        bytes: Buffer.byteLength(JSON.stringify(record)),
      });
  }
  packs.clear();
  candidates.sort((a, b) => b.bytes - a.bytes);
  report.largestOperations = candidates.slice(0, 5);
  const deployment = server.find((file) =>
    file.file.endsWith("/wrangler.json"),
  );
  if (!deployment) throw new Error("No adapter deployment config");
  const configPath = path.join(root, deployment.file),
    config = JSON.parse(await readFile(configPath, "utf8"));
  const portServer = createServer();
  await new Promise<void>((resolve) =>
    portServer.listen(0, "127.0.0.1", resolve),
  );
  const address = portServer.address();
  if (!address || typeof address === "string")
    throw new Error("Cannot allocate inspector port");
  const inspectorPort = address.port;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));
  const wrangler = await import(
    pathToFileURL(
      path.join(adapterRoot, "node_modules/wrangler/wrangler-dist/cli.js"),
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
      inspectorPort,
      logLevel: "error",
      experimental: {
        disableExperimentalWarning: true,
        disableDevRegistry: true,
      },
    },
  );
  const targets = await (
    await fetch(`http://127.0.0.1:${inspectorPort}/json/list`)
  ).json();
  const target =
    targets.find((item: any) => item.type === "node") ?? targets[0];
  if (!target) throw new Error("No inspector target");
  // Node's built-in WebSocket fails Wrangler's inspector handshake; `ws` works.
  const { default: InspectorSocket } = await import(
    pathToFileURL(path.join(adapterRoot, "node_modules/ws/wrapper.mjs")).href
  );
  ws = new InspectorSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws!.addEventListener("open", () => resolve(), { once: true });
    ws!.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: any) => void }
  >();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    message.error
      ? callback.reject(message.error)
      : callback.resolve(message.result);
  });
  const send = (method: string, params = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      ws!.send(JSON.stringify({ id, method, params }));
    });
  await send("Profiler.enable");
  await send("Profiler.setSamplingInterval", { interval: 100 });
  const pages = new Map<string, string>();
  async function requestRun(name: string, urls: string[]) {
    await send("Profiler.start");
    const started = performance.now();
    const responses = await Promise.all(
      urls.map(async (url) => {
        const response = await worker.fetch(url);
        const text = await response.text();
        if (response.status !== 200)
          throw new Error(`${url}: ${response.status} ${text.slice(0, 500)}`);
        const island = url.includes("/_server-islands/");
        if (!island && !text.includes("</html>"))
          throw new Error(`${url}: incomplete HTML (${text.length} bytes)`);
        if (text.includes("nimbus-ref:"))
          throw new Error("Unresolved page token in full renderer output");
        pages.set(url, text);
        return {
          url,
          status: response.status,
          htmlBytes: Buffer.byteLength(text),
          gzipBytes: gzipSync(text).length,
          ...(island
            ? {
                cacheTag: response.headers.get("cache-tag"),
                cacheControl: response.headers.get("cache-control"),
              }
            : {}),
        };
      }),
    );
    const wallMs = performance.now() - started;
    const { profile } = await send("Profiler.stop");
    const names = new Map(
      profile.nodes.map((node: any) => [node.id, node.callFrame.functionName]),
    );
    let active = 0;
    for (let i = 0; i < profile.samples.length; i++)
      if (!["(idle)", "(root)"].includes(String(names.get(profile.samples[i]))))
        active += profile.timeDeltas[i];
    report.requests.push({
      name,
      wallMs,
      profileActiveMs: active / 1000,
      responses,
    });
  }
  if (!candidates[0]) throw new Error("No operation pages");
  const typical = candidates[candidates.length >> 1]!;
  // Isolate start-up has its own limit; keep it out of the page's CPU.
  await requestRun("isolate-start", ["/"]);
  // The first API page reads its version's index; later pages reuse it.
  await requestRun("first-api-page", [`/api/${typical.slug}/`]);
  // Record bytes only approximate HTML bytes, so render the largest records
  // and rank by the HTML each one actually sends.
  const top = Number(arg("--top") ?? 5);
  const ranked: Array<{ url: string; htmlBytes: number; coldMs: number }> = [];
  for (const candidate of candidates.slice(0, top * 5)) {
    const url = `/api/${candidate.slug}/`;
    await requestRun(`page:${candidate.slug}`, [url]);
    const run = report.requests.at(-1);
    ranked.push({
      url,
      htmlBytes: run.responses[0].htmlBytes,
      coldMs: run.profileActiveMs,
    });
  }
  ranked.sort((a, b) => b.htmlBytes - a.htmlBytes);
  report.largestPages = [];
  const median = async (name: string, url: string) => {
    const runs = [];
    for (let i = 0; i < 7; i++) {
      await requestRun(name, [url]);
      runs.push(report.requests.at(-1));
    }
    runs.sort((a, b) => a.profileActiveMs - b.profileActiveMs);
    return runs[3];
  };
  // --also measures named pages too, such as another run's largest.
  const also = (arg("--also") ?? "").split(",").filter(Boolean);
  for (const url of also)
    if (!ranked.some((page) => page.url === url)) {
      await requestRun(`page:${url}`, [url]);
      const run = report.requests.at(-1);
      ranked.push({
        url,
        htmlBytes: run.responses[0].htmlBytes,
        coldMs: run.profileActiveMs,
      });
    }
  const measured = [
    ...ranked.slice(0, top),
    ...ranked.filter(
      (page, i) => i >= top && also.includes(page.url),
    ),
  ];
  for (const page of measured) {
    const warm = await median(`warm:${page.url}`, page.url);
    // Each server island is one more GET, issued by the page once it loads.
    const islands = [
      ...pages
        .get(page.url)!
        .matchAll(/<link rel="preload" as="fetch" href="([^"]+)"/g),
    ].map((match) => match[1]!.replaceAll("&amp;", "&"));
    const islandRuns = [];
    for (const island of islands) {
      await requestRun(`island:${page.url}`, [island]);
      const cold = report.requests.at(-1);
      const again = await median(`island-warm:${page.url}`, island);
      islandRuns.push({
        bytes: cold.responses[0].htmlBytes,
        coldMs: cold.profileActiveMs,
        warmMs: again.profileActiveMs,
        cacheTag: cold.responses[0].cacheTag,
        cacheControl: cold.responses[0].cacheControl,
      });
    }
    report.largestPages.push({
      ...page,
      gzipBytes: warm.responses[0].gzipBytes,
      warmMs: warm.profileActiveMs,
      islands: islandRuns,
    });
  }
  await writeFile(
    path.join(root, "largest.html"),
    pages.get(ranked[0]!.url)!,
  );
  const mixed = Array.from(
    { length: Math.min(16, versionCount) },
    (_, i) =>
      `/api/${candidates[i % candidates.length].slug}/?version=${versions[i]!.version}`,
  );
  await requestRun("mixed-concurrent", mixed);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        report: reportPath,
        build: report.phases.build,
        outputs: report.outputs,
        navigation: report.navigation,
        largestPages: report.largestPages,
        requests: report.requests.map(
          ({ name, wallMs, profileActiveMs }: any) => ({
            name,
            wallMs,
            profileActiveMs,
          }),
        ),
      },
      null,
      2,
    ),
  );
} catch (error) {
  report.error =
    error instanceof Error
      ? { message: error.message, stack: error.stack }
      : error;
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  throw error;
} finally {
  ws?.close();
  await worker?.stop();
  if (!args.includes("--keep"))
    await rm(root, { recursive: true, force: true });
}
