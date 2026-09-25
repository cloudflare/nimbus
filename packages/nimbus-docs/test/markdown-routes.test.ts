// Site-wide Markdown routes: one `markdownRoute()` / `markdownSourceRoute()`
// file serves every collection, and a more specific site route takes over
// the URLs it matches without a prerender conflict.

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
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";

import { build, type AstroIntegration } from "astro";

import nimbus from "../src/index.ts";
import {
  findOwnMarkdownRoute,
  findUnclaimedMarkdownPaths,
  formatUnclaimedMarkdownPaths,
  higherMarkdownRouteOwner,
  routeParams,
  type MarkdownRouteRecord,
} from "../src/_internal/markdown-routes.ts";
import {
  recordMarkdownRoutes,
  sharedMarkdownRouteSurface,
} from "../src/_internal/markdown-routes-plugin.ts";
import { runningNimbusVersion } from "../src/_internal/upgrades.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

const moduleUrl = (relative: string) =>
  JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, relative)).href);

const SHARED_MD = `import { markdownRoute } from ${moduleUrl("../src/agent-endpoints.ts")};
export const prerender = true;
export const { GET, getStaticPaths } = markdownRoute();
`;
const SHARED_MDX = `import { markdownSourceRoute } from ${moduleUrl("../src/agent-endpoints.ts")};
export const prerender = true;
export const { GET, getStaticPaths } = markdownSourceRoute();
`;

function resolvedRoute(
  entrypoint: string,
  pattern: string,
  options: { prerendered?: boolean; type?: "endpoint" | "page" } = {},
) {
  const parts = pattern.split("/").filter(Boolean);
  const segments = parts.map((part) => {
    const spread = /^\[\.\.\.(\w+)\]$/.exec(part);
    const dynamic = /^\[(\w+)\]$/.exec(part);
    return [
      {
        content: spread?.[1] ?? dynamic?.[1] ?? part,
        dynamic: Boolean(spread || dynamic),
        spread: Boolean(spread),
      },
    ];
  });
  const source = segments
    .map(([part]) =>
      part!.spread
        ? "(?:\\/(.*?))?"
        : part!.dynamic
          ? "\\/([^/]+?)"
          : `\\/${part!.content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    )
    .join("");
  return {
    type: options.type ?? ("endpoint" as const),
    segments,
    pattern,
    patternRegex: new RegExp(`^${source}$`),
    params: segments
      .filter(([part]) => part!.dynamic)
      .map(([part]) => (part!.spread ? `...${part!.content}` : part!.content)),
    entrypoint,
    isPrerendered: options.prerendered ?? true,
  };
}

const sources: Record<string, string> = {
  "src/pages/[...slug]/index.md.ts": SHARED_MD,
  "src/pages/[...slug]/index.mdx.ts": SHARED_MDX,
  "src/pages/changelog/[...slug]/index.md.ts": "export const prerender = true;",
};

function records(): MarkdownRouteRecord[] {
  return recordMarkdownRoutes(
    [
      resolvedRoute("src/pages/changelog/[...slug]/index.md.ts", "/changelog/[...slug]/index.md"),
      resolvedRoute("src/pages/[...slug]/index.md.ts", "/[...slug]/index.md"),
      resolvedRoute("src/pages/[...slug]/index.mdx.ts", "/[...slug]/index.mdx"),
      resolvedRoute("src/pages/[...slug].astro", "/[...slug]", { type: "page" }),
      resolvedRoute("src/pages/raw/[...path].ts", "/raw/[...path]"),
    ],
    (entrypoint) => sources[entrypoint],
  );
}

test("records static .md and .mdx endpoints in priority order and detects the shared factories", () => {
  const recorded = records();
  assert.deepEqual(
    recorded.map(({ entrypoint, params, shared }) => ({ entrypoint, params, shared })),
    [
      { entrypoint: "src/pages/changelog/[...slug]/index.md.ts", params: ["slug"], shared: undefined },
      { entrypoint: "src/pages/[...slug]/index.md.ts", params: ["slug"], shared: "markdown" },
      { entrypoint: "src/pages/[...slug]/index.mdx.ts", params: ["slug"], shared: "source" },
    ],
  );
  const [changelog, shared] = recorded;
  assert.deepEqual(routeParams(shared!, "/v1/guide/index.md"), { slug: "v1/guide" });
  assert.deepEqual(routeParams(shared!, "/index.md"), { slug: undefined });
  assert.equal(routeParams(shared!, "/guide/index.mdx"), null);
  assert.equal(higherMarkdownRouteOwner(recorded, 1, "/changelog/a/index.md"), changelog);
  assert.equal(higherMarkdownRouteOwner(recorded, 1, "/guide/index.md"), undefined);
});

test("detects the factories only when imported from agent-endpoints", () => {
  const importLine = 'import { markdownRoute } from "@cloudflare/nimbus-docs/agent-endpoints";';
  assert.equal(sharedMarkdownRouteSurface(`${importLine}\nmarkdownRoute();`), "markdown");
  assert.equal(
    sharedMarkdownRouteSurface(
      'import { markdownSourceRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\nmarkdownSourceRoute();',
    ),
    "source",
  );
  assert.equal(sharedMarkdownRouteSurface("const markdownRoute = () => {};\nmarkdownRoute();"), undefined);
  assert.equal(sharedMarkdownRouteSurface(importLine), undefined);
});

test("detects aliased, namespace, and dynamic factory imports, and ignores comments", () => {
  const from = '"@cloudflare/nimbus-docs/agent-endpoints"';
  assert.equal(
    sharedMarkdownRouteSurface(
      `import { getMarkdownPayload, markdownRoute as route } from ${from};\nexport const { GET, getStaticPaths } = route();`,
    ),
    "markdown",
  );
  assert.equal(
    sharedMarkdownRouteSurface(`import * as endpoints from ${from};\nendpoints.markdownSourceRoute();`),
    "source",
  );
  assert.equal(
    sharedMarkdownRouteSurface(`const { markdownRoute } = await import(${from});\nmarkdownRoute();`),
    "markdown",
  );
  assert.equal(
    sharedMarkdownRouteSurface(
      `import { getMarkdownPayload } from ${from};\n// Unlike markdownRoute(), this serves docs only.\n/* markdownSourceRoute() */`,
    ),
    undefined,
  );
  assert.equal(
    sharedMarkdownRouteSurface(`import type { markdownRoute } from ${from};\nmarkdownRoute();`),
    undefined,
  );
});

test("an aliased factory in a route that is not prerendered fails", () => {
  assert.throws(
    () =>
      recordMarkdownRoutes(
        [resolvedRoute("src/pages/[...slug]/index.md.ts", "/[...slug]/index.md", { prerendered: false })],
        () =>
          'import { markdownRoute as route } from "@cloudflare/nimbus-docs/agent-endpoints";\nexport const prerender = false;\nexport const { GET, getStaticPaths } = route();\n',
      ),
    /uses markdownRoute\(\) but is not prerendered/,
  );
});

test("a shared route that is not prerendered fails with a clear message", () => {
  assert.throws(
    () =>
      recordMarkdownRoutes(
        [resolvedRoute("src/pages/[...slug]/index.md.ts", "/[...slug]/index.md", { prerendered: false })],
        () => SHARED_MD,
      ),
    /src\/pages\/\[\.\.\.slug\]\/index\.md\.ts uses markdownRoute\(\) but is not prerendered[\s\S]*export const prerender = true/,
  );
});

test("a factory in a route of the other extension fails", () => {
  assert.throws(
    () =>
      recordMarkdownRoutes(
        [resolvedRoute("src/pages/[...slug]/index.mdx.ts", "/[...slug]/index.mdx")],
        () => SHARED_MD,
      ),
    /uses markdownRoute\(\), which serves \.md files, but its route ends in "index\.mdx"/,
  );
});

test("finds the factory's own route by entrypoint and pattern", () => {
  const recorded = records();
  assert.equal(findOwnMarkdownRoute(recorded, "/[...slug]/index.md", "markdown"), 1);
  assert.equal(findOwnMarkdownRoute(recorded, "/[...slug]/index.mdx", "source"), 2);
  assert.equal(
    findOwnMarkdownRoute(recorded, "/changelog/[...slug]/index.md", "markdown"),
    0,
    "a factory reached indirectly falls back to the single route with its pattern",
  );
  assert.throws(
    () => findOwnMarkdownRoute(recorded, "/raw/[...path]", "markdown"),
    /is not an endpoint whose last segment is a static \.md or \.mdx file name/,
  );
  const duplicate = [...recorded, { ...recorded[0]!, entrypoint: "src/pages/changelog/[...slug]/index.md.js" }];
  assert.throws(
    () => findOwnMarkdownRoute(duplicate, "/changelog/[...slug]/index.md", "markdown"),
    /cannot tell which file serves \/changelog\/\[\.\.\.slug\]\/index\.md/,
  );
});

test("reports URLs a prerendered owner skipped but did not generate", () => {
  const recorded = records();
  const assets = [
    { url: "/guide/index.md", surface: "markdown" as const },
    { url: "/changelog/a/index.md", surface: "markdown" as const },
    { url: "/changelog/b/index.md", surface: "markdown" as const },
    { url: "/changelog/b/index.mdx", surface: "source" as const },
  ];
  const unclaimed = findUnclaimedMarkdownPaths(
    recorded,
    assets,
    new Set(["/guide/index.md", "/changelog/a/index.md", "/changelog/b/index.mdx"]),
  );
  assert.deepEqual(
    unclaimed.map(({ url, owner }) => [url, owner.entrypoint]),
    [["/changelog/b/index.md", "src/pages/changelog/[...slug]/index.md.ts"]],
  );
  assert.match(
    formatUnclaimedMarkdownPaths(unclaimed),
    /1 Markdown path belong[\s\S]*src\/pages\/changelog\/\[\.\.\.slug\]\/index\.md\.ts \(\/changelog\/\[\.\.\.slug\]\/index\.md\) matches but did not generate: \/changelog\/b\/index\.md/,
  );

  const onDemandOwner = recorded.map((route, index) =>
    index === 0 ? { ...route, prerendered: false } : route,
  );
  assert.deepEqual(
    findUnclaimedMarkdownPaths(onDemandOwner, assets, new Set()).map(({ url }) => url),
    [],
    "an owner rendered on request serves the URL itself",
  );
});

/** A minimal on-demand adapter: Astro's generated App behind the entrypoint. */
function testAdapter(entrypoint: string): AstroIntegration {
  return {
    name: "test:adapter",
    hooks: {
      "astro:config:done": ({ setAdapter }) => {
        setAdapter({
          name: "test:adapter",
          entrypointResolution: "auto",
          serverEntrypoint: entrypoint,
          supportedAstroFeatures: { serverOutput: "stable" },
        });
      },
    },
  };
}

interface Site {
  root: string;
  logs: string;
}

async function buildSite(
  pages: Record<string, string>,
  options: {
    conflict?: "error" | "warn";
    server?: boolean;
    logLevel?: "silent" | "warn";
  } = {},
): Promise<Site> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-markdown-routes-"));
  roots.push(root);
  const write = async (relative: string, contents: string) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents, "utf8");
  };
  await write(
    "nimbus.json",
    `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`,
  );
  await symlink(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const spec = path.resolve(import.meta.dirname, "fixtures/api/smallco.yaml");
  const api = {
    collection: "api",
    versions: [
      { version: "v2", default: true, spec },
      { version: "v1", spec, hidden: true },
    ],
  };
  await write(
    "src/content.config.ts",
    `import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { apiCollection, docsCollection } from ${moduleUrl("../src/content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  "docs-v1": defineCollection(docsCollection({ base: "docs-v1" })),
  changelog: defineCollection(
    docsCollection({
      base: "changelog",
      schemaFields: { date: z.coerce.date(), tags: z.array(z.string()).default([]) },
    }),
  ),
  api: defineCollection(apiCollection(${JSON.stringify(api)})),
};`,
  );
  await write("src/content/docs/index.mdx", "---\ntitle: Home\n---\nHome body.\n");
  await write(
    "src/content/docs/guide.mdx",
    "---\ntitle: Guide\ndescription: Read me\n---\nGuide body with [home](/).\n",
  );
  await write("src/content/docs-v1/guide.mdx", "---\ntitle: Old guide\n---\nOld guide body.\n");
  await write(
    "src/content/changelog/2026-01-01-first.mdx",
    "---\ntitle: First\ndate: 2026-01-01\ntags: [launch]\n---\nFirst entry.\n",
  );
  await write(
    "src/content/changelog/2026-02-01-second.mdx",
    "---\ntitle: Second\ndate: 2026-02-01\n---\nSecond entry.\n",
  );
  await write("src/pages/index.astro", "---\nexport const prerender = true;\n---\n<h1>Home</h1>");
  for (const [relative, contents] of Object.entries(pages)) {
    await write(relative, contents);
  }
  let adapter: AstroIntegration | undefined;
  if (options.server) {
    await write(
      "server-entry.mjs",
      `import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n`,
    );
    adapter = testAdapter(path.join(root, "server-entry.mjs"));
  }

  const chunks: string[] = [];
  const streams = [process.stdout, process.stderr] as const;
  const realWrites = streams.map((stream) => stream.write);
  for (const [index, stream] of streams.entries()) {
    const realWrite = realWrites[index]!.bind(stream) as (...args: unknown[]) => boolean;
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      chunks.push(String(chunk));
      return realWrite(chunk, ...rest);
    }) as typeof stream.write;
  }
  try {
    await build({
      root: pathToFileURL(`${root}${path.sep}`),
      cacheDir: path.join(root, ".astro"),
      outDir: "./dist",
      build: { server: path.join(root, ".server"), client: path.join(root, "dist") },
      vite: { cacheDir: path.join(root, ".vite") },
      base: "/docs",
      prerenderConflictBehavior: options.conflict ?? "error",
      ...(adapter ? { output: "server" as const, adapter } : {}),
      logLevel: options.logLevel ?? "silent",
      integrations: [
        nimbus(
          {
            site: "https://example.test",
            title: "Test",
            description: "Test",
            search: false,
            versions: { current: "v2", others: ["v1"] },
            api: [api],
          },
          { admonitions: false, sitemap: false, validateMdx: false },
        ),
      ],
    });
  } finally {
    for (const [index, stream] of streams.entries()) stream.write = realWrites[index]!;
  }
  return { root, logs: chunks.join("") };
}

async function files(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? files(path.join(dir, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`],
    ),
  );
  return nested.flat();
}

async function markdownOutputs(root: string): Promise<string[]> {
  return (await files(path.join(root, "dist")))
    .filter((file) => /\.mdx?$/.test(file) && !file.startsWith("_nimbus/"))
    .sort();
}

async function manifest(root: string) {
  return JSON.parse(
    await readFile(path.join(root, ".astro/nimbus/agent-endpoint-assets/manifest.json"), "utf8"),
  ) as {
    version: number;
    markdownAssets: Array<{ collection: string; id: string; surface: string; url: string }>;
  };
}

const WRAPPED_CHANGELOG = `import { markdownRoute } from ${moduleUrl("../src/agent-endpoints.ts")};
export const prerender = true;
const route = markdownRoute();
export const getStaticPaths = route.getStaticPaths;
export async function GET(context) {
  const response = await route.GET(context);
  return new Response(\`\${await response.text()}<!-- changelog override -->\\n\`, response);
}
`;

const PARTIAL_CHANGELOG = `export const prerender = true;
export const getStaticPaths = () => [{ params: { slug: "2026-01-01-first" } }];
export const GET = () => new Response("first only\\n");
`;

test("two shared files serve every collection under a base, and a changelog override wins with no conflict", async () => {
  const site = await buildSite({
    "src/pages/[...slug]/index.md.ts": SHARED_MD,
    "src/pages/[...slug]/index.mdx.ts": SHARED_MDX,
    "src/pages/changelog/[...slug]/index.md.ts": WRAPPED_CHANGELOG,
  });
  const baked = await manifest(site.root);
  assert.equal(baked.version, 5);

  const outputs = await markdownOutputs(site.root);
  const api = outputs.filter((file) => file.startsWith("api/"));
  assert.ok(api.length > 20, `expected API pages, found ${api.length}`);
  assert.ok(api.every((file) => file.endsWith("/index.md")), "API pages have no .mdx");
  assert.ok(!api.some((file) => file.startsWith("api/v1/")), "hidden API version got .md files");
  assert.ok(!baked.markdownAssets.some((asset) => asset.url.startsWith("/api/v1/")));
  assert.deepEqual(
    outputs.filter((file) => !file.startsWith("api/")),
    [
      "changelog/2026-01-01-first/index.md",
      "changelog/2026-01-01-first/index.mdx",
      "changelog/2026-02-01-second/index.md",
      "changelog/2026-02-01-second/index.mdx",
      "guide/index.md",
      "guide/index.mdx",
      "index.md",
      "index.mdx",
      "v1/guide/index.md",
      "v1/guide/index.mdx",
    ],
  );
  assert.deepEqual(
    outputs,
    baked.markdownAssets.map((asset) => asset.url.slice(1)).sort(),
    "every baked asset is built exactly at its public URL",
  );

  const guide = await readFile(path.join(site.root, "dist/guide/index.md"), "utf8");
  assert.match(guide, /^---\ntitle: "Guide"\ndescription: "Read me"\nversion: "v2"\n---/);
  assert.match(guide, /Source: https:\/\/example\.test\/docs\/guide\/index\.mdx\n$/);
  const operation = await readFile(path.join(site.root, "dist/api/charges/create/index.md"), "utf8");
  assert.match(operation, /Source: https:\/\/example\.test\/docs\/api\/charges\/create\/index\.md\n$/);
  assert.doesNotMatch(operation, /\n# Create a charge\n\n# /);

  const changelog = await readFile(
    path.join(site.root, "dist/changelog/2026-01-01-first/index.md"),
    "utf8",
  );
  assert.match(changelog, /First entry\.[\s\S]*<!-- changelog override -->\n$/);
  assert.doesNotMatch(guide, /changelog override/);
});

test("a partial override warns with the skipped paths and the owning route", async () => {
  const site = await buildSite(
    {
      "src/pages/[...slug]/index.md.ts": SHARED_MD,
      "src/pages/changelog/[...slug]/index.md.ts": PARTIAL_CHANGELOG,
    },
    { conflict: "warn", logLevel: "warn" },
  );
  assert.match(
    site.logs,
    /src\/pages\/changelog\/\[\.\.\.slug\]\/index\.md\.ts \(\/changelog\/\[\.\.\.slug\]\/index\.md\) matches but did not generate: \/changelog\/2026-02-01-second\/index\.md/,
  );
  assert.doesNotMatch(site.logs, /conflicts with higher priority route/);
  const outputs = await markdownOutputs(site.root);
  assert.ok(outputs.includes("changelog/2026-01-01-first/index.md"));
  assert.ok(!outputs.includes("changelog/2026-02-01-second/index.md"));
});

test("a partial override fails the build when prerender conflicts are errors", async () => {
  await assert.rejects(
    buildSite({
      "src/pages/[...slug]/index.md.ts": SHARED_MD,
      "src/pages/changelog/[...slug]/index.md.ts": PARTIAL_CHANGELOG,
    }),
    /matches but did not generate: \/changelog\/2026-02-01-second\/index\.md/,
  );
});

test("a shared route that is not prerendered fails the build", async () => {
  await assert.rejects(
    buildSite(
      { "src/pages/[...slug]/index.md.ts": SHARED_MD.replace("prerender = true", "prerender = false") },
      { server: true },
    ),
    /uses markdownRoute\(\) but is not prerendered/,
  );
});

test("on request, GET serves by URL, returns 404 for unknown paths, and 500 without details", async () => {
  const site = await buildSite(
    {
      "src/lib/markdown.ts": `import { markdownRoute } from ${moduleUrl("../src/agent-endpoints.ts")};
export const route = markdownRoute();
`,
      "src/pages/[...slug]/index.md.ts": `import { route } from "../../lib/markdown";
export const prerender = false;
export const GET = route.GET;
`,
    },
    { server: true },
  );
  const { app } = (await import(pathToFileURL(path.join(site.root, ".server/entry.mjs")).href)) as {
    app: { render(request: Request): Promise<Response> };
  };

  const guide = await app.render(new Request("https://example.test/docs/guide/index.md"));
  assert.equal(guide.status, 200);
  assert.equal(guide.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.match(await guide.text(), /Guide body/);
  const api = await app.render(new Request("https://example.test/docs/api/charges/create/index.md"));
  assert.equal(api.status, 200);

  const missing = await app.render(new Request("https://example.test/docs/missing/index.md"));
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "Not found");

  const asset = (await manifest(site.root)).markdownAssets.find(
    (candidate) => candidate.url === "/v1/guide/index.md",
  ) as unknown as { path: string };
  await rm(path.join(site.root, ".astro/nimbus/agent-endpoint-assets", asset.path));
  const realFetch = globalThis.fetch;
  const realError = console.error;
  globalThis.fetch = async () => new Response("gone", { status: 503 });
  console.error = () => {};
  try {
    const failed = await app.render(new Request("https://example.test/docs/v1/guide/index.md"));
    assert.equal(failed.status, 500);
    assert.equal(await failed.text(), "Internal Server Error");
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
});
