// Site-wide Markdown routes: one `markdownRoute()` / `markdownSourceRoute()`
// file serves every collection, and a more specific site route takes over
// the URLs it matches without a prerender conflict.

import assert from "node:assert/strict";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  findOwnMarkdownRoute,
  findUnclaimedMarkdownPaths,
  formatUnclaimedMarkdownPaths,
  higherMarkdownRouteOwner,
  routeParams,
  type MarkdownRouteRecord,
} from "../src/_internal/markdown-routes.ts";
import {
  agentFactoryCall,
  describeUnreadAgentRoute,
  patternsMayOverlap,
  recordMarkdownRoutes,
  sharedMarkdownRouteSurface,
  unreadAgentRoutes,
} from "../src/_internal/markdown-routes-plugin.ts";
import {
  agentManifest as manifest,
  agentSites,
  REQUEST_DOCS_PAGE,
  siteApp,
  SMALLCO_SPEC,
  type AgentSite,
  type AgentSiteOptions,
} from "./fixtures/agent-site.ts";

const sites = agentSites();

afterEach(() => sites.cleanup());

const API = {
  collection: "api",
  schemaPages: true,
  versions: [
    { version: "v2", default: true, spec: SMALLCO_SPEC },
    { version: "v1", spec: SMALLCO_SPEC, hidden: true },
  ],
};

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

test("an aliased factory in a route that is not prerendered is recorded, not an error", () => {
  // Agent files follow the rendering policy, so a shared route may render on
  // request; the record keeps its mode and the factory serves by URL.
  const records = recordMarkdownRoutes(
    [resolvedRoute("src/pages/[...slug]/index.md.ts", "/[...slug]/index.md", { prerendered: false })],
    () =>
      'import { markdownRoute as route } from "@cloudflare/nimbus-docs/agent-endpoints";\nexport const prerender = false;\nexport const { GET, getStaticPaths } = route();\n',
  );
  assert.equal(records[0]?.shared, "markdown");
  assert.equal(records[0]?.prerendered, false);
});

test("a shared route that is not prerendered keeps its record", () => {
  const records = recordMarkdownRoutes(
    [resolvedRoute("src/pages/[...slug]/index.md.ts", "/[...slug]/index.md", { prerendered: false })],
    () => SHARED_MD,
  );
  assert.equal(records[0]?.shared, "markdown");
  assert.equal(records[0]?.prerendered, false);
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

async function buildSite(
  pages: Record<string, string>,
  options: Pick<AgentSiteOptions, "conflict" | "server" | "logLevel" | "rendering"> = {},
): Promise<AgentSite> {
  return sites.buildSite(
    {
      "src/content.config.ts": `import { defineCollection } from "astro:content";
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
  api: defineCollection(apiCollection(${JSON.stringify(API)})),
};`,
      "src/content/docs/index.mdx": "---\ntitle: Home\n---\nHome body.\n",
      "src/content/docs/guide.mdx":
        "---\ntitle: Guide\ndescription: Read me\n---\nGuide body with [home](/).\n",
      "src/content/docs-v1/guide.mdx": "---\ntitle: Old guide\n---\nOld guide body.\n",
      "src/content/changelog/2026-01-01-first.mdx":
        "---\ntitle: First\ndate: 2026-01-01\ntags: [launch]\n---\nFirst entry.\n",
      "src/content/changelog/2026-02-01-second.mdx":
        "---\ntitle: Second\ndate: 2026-02-01\n---\nSecond entry.\n",
      "src/pages/index.astro": "---\nexport const prerender = true;\n---\n<h1>Home</h1>",
      ...pages,
    },
    { ...options, versions: { current: "v2", others: ["v1"] }, api: [API] },
  );
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

const LLMS_ROUTES = {
  "src/pages/llms.txt.ts": `import { llmsRoute } from ${moduleUrl("../src/agent-endpoints.ts")};
export const prerender = true;
export const { GET } = llmsRoute();
`,
  "src/pages/llms-full.txt.ts": `import { llmsFullRoute } from ${moduleUrl("../src/agent-endpoints.ts")};
export const prerender = true;
export const { GET } = llmsFullRoute();
`,
  "src/pages/[section]/llms.txt.ts": `import { llmsSectionRoute } from ${moduleUrl("../src/agent-endpoints.ts")};
export const prerender = true;
export const { GET, getStaticPaths } = llmsSectionRoute();
`,
};

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
  const site = await buildSite(
    {
      "src/pages/[...slug]/index.md.ts": SHARED_MD,
      "src/pages/[...slug]/index.mdx.ts": SHARED_MDX,
      "src/pages/changelog/[...slug]/index.md.ts": WRAPPED_CHANGELOG,
      ...LLMS_ROUTES,
    },
    { logLevel: "warn" },
  );
  assert.doesNotMatch(site.logs, /not prerendered|did not generate/);
  const baked = await manifest(site.root);
  assert.equal(baked.version, 7);

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
  assert.doesNotMatch(site.logs, /not prerendered/, "the skipped path is reported once");
  const outputs = await markdownOutputs(site.root);
  assert.ok(outputs.includes("changelog/2026-01-01-first/index.md"));
  assert.ok(!outputs.includes("changelog/2026-02-01-second/index.md"));
});

test("a partial override stays silent when prerender conflicts are ignored", async () => {
  const site = await buildSite(
    {
      "src/pages/[...slug]/index.md.ts": SHARED_MD,
      "src/pages/changelog/[...slug]/index.md.ts": PARTIAL_CHANGELOG,
    },
    { conflict: "ignore", logLevel: "warn" },
  );
  assert.doesNotMatch(site.logs, /did not generate|not prerendered/);
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

test("a shared route rendered on request builds without Markdown files", async () => {
  const site = await buildSite(
    { ...REQUEST_DOCS_PAGE, "src/pages/[...slug]/index.md.ts": SHARED_MD.replace("prerender = true", "prerender = false") },
    { server: true, logLevel: "warn", rendering: { default: "request" } },
  );
  assert.doesNotMatch(site.logs, /not prerendered/);
  await assert.rejects(readFile(path.join(site.root, "dist/guide/index.md"), "utf8"));
});

test("a re-exported factory rendered on request serves by URL, 404s unknown paths, and 500s without details", async () => {
  const site = await buildSite(
    {
      ...REQUEST_DOCS_PAGE,
      "src/lib/markdown.ts": `import { markdownRoute } from ${moduleUrl("../src/agent-endpoints.ts")};
export const route = markdownRoute();
`,
      "src/pages/[...slug]/index.md.ts": `import { route } from "../../lib/markdown";
export const prerender = false;
export const GET = route.GET;
`,
    },
    { server: true, logLevel: "warn", rendering: { default: "request" } },
  );
  // A request-rendered shared route is normal operation now — agent files
  // follow the rendering policy — so the build warns about nothing.
  assert.doesNotMatch(site.logs, /not prerendered/);
  const app = await siteApp(site);

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

// Astro's own segment shape for a route pattern: `[...slug].md` is one segment
// of two parts, a spread and the static `.md`, which `recordMarkdownRoutes`
// rejects while the pattern's regex still matches every `.md` URL.
function astroRoute(entrypoint: string, pattern: string, origin: "project" | "internal" = "project") {
  const segments = pattern
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const parts: Array<{ content: string; dynamic: boolean; spread: boolean }> = [];
      for (const match of segment.matchAll(/\[(\.\.\.)?(\w+)\]|([^[\]]+)/gu)) {
        if (match[3] !== undefined) parts.push({ content: match[3], dynamic: false, spread: false });
        else parts.push({ content: match[2]!, dynamic: true, spread: match[1] !== undefined });
      }
      return parts;
    });
  const source = segments
    .map((parts) =>
      `\\/${parts
        .map((part) => (part.spread ? "(.*?)" : part.dynamic ? "([^/]+?)" : part.content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("")}`,
    )
    .join("");
  return {
    type: "endpoint" as const,
    origin,
    segments,
    pattern,
    patternRegex: new RegExp(`^${source}$`),
    params: [],
    entrypoint,
    isPrerendered: false,
  };
}

const ENDPOINTS = 'from "@cloudflare/nimbus-docs/agent-endpoints";';

test("agentFactoryCall names the factory called, through every import form, with the surface derived from it", () => {
  assert.equal(agentFactoryCall(`import { markdownRoute } ${ENDPOINTS}\nexport const { GET } = markdownRoute();`), "markdownRoute");
  assert.equal(agentFactoryCall(`import { llmsRoute as index } ${ENDPOINTS}\nconst r = index();`), "llmsRoute");
  assert.equal(agentFactoryCall(`import * as agents ${ENDPOINTS}\nexport const { GET } = agents.llmsSectionRoute();`), "llmsSectionRoute");
  assert.equal(agentFactoryCall(`const { llmsFullRoute } = await import("@cloudflare/nimbus-docs/agent-endpoints");\nllmsFullRoute();`), "llmsFullRoute");
  assert.equal(agentFactoryCall(`import { markdownRoute } ${ENDPOINTS}\n// markdownRoute()\nexport const GET = () => new Response("x");`), undefined);
  assert.equal(agentFactoryCall(`import { markdownRoute } from "./helper";\nmarkdownRoute();`), undefined);
  // A factory named in response text, a template or a string is not a call.
  assert.equal(agentFactoryCall(`import { markdownRoute } ${ENDPOINTS}\nexport const GET = () => new Response("Example: markdownRoute()");`), undefined);
  assert.equal(agentFactoryCall(`import { llmsRoute } ${ENDPOINTS}\nexport const GET = () => new Response(\`see \${"llmsRoute()"} here\`);`), undefined);
  assert.equal(agentFactoryCall(`import { llmsRoute } ${ENDPOINTS}\nconst note = 'llmsRoute()';\nexport const { GET } = llmsRoute();`), "llmsRoute");
  // Regex literals and quotes inside template expressions neither hide a call nor make one.
  assert.equal(agentFactoryCall(`import { markdownRoute } ${ENDPOINTS}\nconst quote = /"/;\nexport const { GET } = markdownRoute();`), "markdownRoute");
  assert.equal(agentFactoryCall(`import { markdownRoute } ${ENDPOINTS}\nconst example = /markdownRoute()/;\nexport const GET = () => new Response("x");`), undefined);
  assert.equal(agentFactoryCall(`import { markdownRoute } ${ENDPOINTS}\nconst text = \`\${"{"}\`;\nexport const { GET } = markdownRoute();`), "markdownRoute");
  assert.equal(agentFactoryCall(`import { markdownRoute } ${ENDPOINTS}\nconst half = 4 / 2 / 1;\nexport const { GET } = markdownRoute();`), "markdownRoute");
  assert.equal(agentFactoryCall(`import { markdownRoute } ${ENDPOINTS}\n/* markdownRoute() */ // markdownRoute()\nexport const GET = () => new Response("x");`), undefined);
  // A regex after a control statement's parenthesis; literals nested in template expressions.
  assert.equal(agentFactoryCall(`import { markdownRoute } ${ENDPOINTS}\nif (true) /markdownRoute()/.test("x");\nexport const GET = () => new Response("x");`), undefined);
  assert.equal(agentFactoryCall(`import { markdownRoute } ${ENDPOINTS}\nif (true) /"/.test("x"); export const { GET } = markdownRoute();`), "markdownRoute");
  assert.equal(agentFactoryCall(`import { markdownRoute } ${ENDPOINTS}\nconst x = \`\${\`a\${"\`"}\`}\`; export const { GET } = markdownRoute();`), "markdownRoute");
  assert.equal(agentFactoryCall(`import { markdownRoute } ${ENDPOINTS}\nconst y = \`\${ /* } */ markdownRoute() }\`;`), "markdownRoute");
  assert.equal(agentFactoryCall(`import { markdownRoute } ${ENDPOINTS}\nconst z = \`\${ /}/.test("x") ? markdownRoute() : "x" }\`;`), "markdownRoute");
  assert.equal(agentFactoryCall(`import { markdownRoute } ${ENDPOINTS}\nconst n = (a)(b) / 2 / markdownRoute();`), "markdownRoute");
  assert.equal(agentFactoryCall(`import { markdownRoute } ${ENDPOINTS}\nfunction f() { return /markdownRoute()/; }`), undefined);
  // A regex after a statement block; division after a postfix increment.
  assert.equal(agentFactoryCall(`import { markdownRoute } ${ENDPOINTS}\nif (true) {} /markdownRoute()/.test("x");`), undefined);
  assert.equal(agentFactoryCall(`import { markdownRoute } ${ENDPOINTS}\nif (true) {} /"/.test("x"); export const { GET } = markdownRoute();`), "markdownRoute");
  assert.equal(agentFactoryCall(`import { markdownRoute } ${ENDPOINTS}\nlet n = 1; const m = n++ / markdownRoute() / 2;`), "markdownRoute");
  assert.equal(sharedMarkdownRouteSurface(`import { llmsFullRoute } ${ENDPOINTS}\nllmsFullRoute();`), "llms");
});

test("patternsMayOverlap walks segments: static mismatch is disjoint, a spread absorbs the rest", () => {
  assert.equal(patternsMayOverlap("/blog/[...slug].md", "/[...slug]/index.md"), true);
  assert.equal(patternsMayOverlap("/[...slug].md", "/[...slug]/index.md"), true);
  assert.equal(patternsMayOverlap("/blog/[...slug].md", "/docs/[...slug]/index.md"), false);
  assert.equal(patternsMayOverlap("/[section]/[...rest].md", "/blog/[...slug]/index.md"), true);
  assert.equal(patternsMayOverlap("/markdown", "/[...slug]/index.md"), false, "a static last segment that is not index.md never serves one");
  assert.equal(patternsMayOverlap("/feed.txt", "/llms.txt"), false);
  assert.equal(patternsMayOverlap("/a/b", "/a"), false);
  // Static affixes on the last segment must agree; a bare spread matches nothing too.
  assert.equal(patternsMayOverlap("/[...slug].json", "/[...slug]/index.md"), false);
  assert.equal(patternsMayOverlap("/[...slug].md", "/[...slug]/index.md"), true);
  assert.equal(patternsMayOverlap("/[...file].txt", "/[...section]/llms.txt"), true);
  assert.equal(patternsMayOverlap("/a", "/a/[...rest]"), true);
  assert.equal(patternsMayOverlap("/a/[...rest]/index.md", "/a"), false);
  // Text before a spread constrains the first segment of its span, not the file name.
  assert.equal(patternsMayOverlap("/raw-[...slug].md", "/[...slug]/index.md"), true);
  assert.equal(patternsMayOverlap("/raw-[...slug].json", "/[...slug]/index.md"), false);
  assert.equal(patternsMayOverlap("/[name].md", "/[...slug]/index.md"), true);
});

test("unreadAgentRoutes names a factory call from a shape Nimbus doesn't record, and the recorded route it may shadow", () => {
  const sources: Record<string, string> = {
    "src/pages/[...slug].md.ts": `import { markdownRoute } ${ENDPOINTS}\nexport const { GET } = markdownRoute();`,
    "src/pages/blog/[...slug].md.ts": `import { markdownRoute as md } ${ENDPOINTS}\nexport const GET = md().GET;`,
    "src/pages/redirects/[...slug].md.ts": "export const GET = (context) => context.redirect('/x', 301);",
    "src/pages/markdown.ts": `import { llmsRoute } ${ENDPOINTS}\nexport const { GET } = llmsRoute();`,
    "src/pages/all.txt.ts": `import { llmsFullRoute } ${ENDPOINTS}\nexport const { GET } = llmsFullRoute();`,
    "site/pages/notes/[...slug].md.ts": `import { markdownRoute } ${ENDPOINTS}\nexport const { GET } = markdownRoute();`,
    "src/pages/[...slug]/index.md.ts": `import { markdownRoute } ${ENDPOINTS}\nexport const { GET, getStaticPaths } = markdownRoute();`,
    "src/pages/docs/[...slug]/index.md.ts": "export const GET = () => new Response('own');",
    "src/pages/llms.txt.ts": `import { llmsRoute } ${ENDPOINTS}\nexport const { GET } = llmsRoute();`,
  };
  // Astro's priority order: the mixed spread+static segments first, then the starter's.
  const routes = [
    astroRoute("src/pages/blog/[...slug].md.ts", "/blog/[...slug].md"),
    astroRoute("src/pages/redirects/[...slug].md.ts", "/redirects/[...slug].md"),
    astroRoute("src/pages/[...slug].md.ts", "/[...slug].md"),
    astroRoute("src/pages/markdown.ts", "/markdown"),
    astroRoute("src/pages/all.txt.ts", "/all.txt"),
    astroRoute("site/pages/notes/[...slug].md.ts", "/notes/[...slug].md"),
    astroRoute("src/pages/llms.txt.ts", "/llms.txt"),
    astroRoute("src/pages/docs/[...slug]/index.md.ts", "/docs/[...slug]/index.md"),
    astroRoute("src/pages/[...slug]/index.md.ts", "/[...slug]/index.md"),
    astroRoute("node_modules/pkg/[llms].txt.ts", "/pets/[llms].txt", "internal"),
  ];
  const read = (file: string) => sources[file];
  const unread = unreadAgentRoutes(routes, read);
  assert.deepEqual(
    unread.map(({ entrypoint, factory, suggested, shadows }) => ({ entrypoint, factory, suggested, shadows })),
    [
      {
        entrypoint: "src/pages/blog/[...slug].md.ts",
        factory: "markdownRoute",
        suggested: "src/pages/blog/[...slug]/index.md.ts",
        shadows: "src/pages/[...slug]/index.md.ts",
      },
      {
        entrypoint: "src/pages/[...slug].md.ts",
        factory: "markdownRoute",
        suggested: "src/pages/[...slug]/index.md.ts",
        shadows: "src/pages/docs/[...slug]/index.md.ts",
      },
      { entrypoint: "src/pages/markdown.ts", factory: "llmsRoute", suggested: "src/pages/llms.txt.ts", shadows: undefined },
      // The suggestion follows the file's own pages folder; the full document at its own name is not reported.
      {
        entrypoint: "site/pages/notes/[...slug].md.ts",
        factory: "markdownRoute",
        suggested: "site/pages/notes/[...slug]/index.md.ts",
        shadows: "src/pages/[...slug]/index.md.ts",
      },
    ],
  );
  // A prefixed old route beside a disjoint recorded one shadows nothing.
  assert.equal(
    unreadAgentRoutes(
      [astroRoute("src/pages/blog/[...slug].md.ts", "/blog/[...slug].md"), astroRoute("src/pages/docs/[...slug]/index.md.ts", "/docs/[...slug]/index.md")],
      read,
    )[0]?.shadows,
    undefined,
  );
  // The recorded routes themselves are untouched.
  assert.deepEqual(
    recordMarkdownRoutes(routes, read).map((route) => route.entrypoint),
    ["src/pages/llms.txt.ts", "src/pages/docs/[...slug]/index.md.ts", "src/pages/[...slug]/index.md.ts", "node_modules/pkg/[llms].txt.ts"],
  );
  const text = describeUnreadAgentRoute(unread[0]!);
  assert.match(text, /^src\/pages\/blog\/\[\.\.\.slug\]\.md\.ts calls markdownRoute\(\), but Nimbus records an agent route only where the last segment is a static file name, so this file publishes nothing: no page's Markdown URL/);
  assert.match(text, /Move the call to src\/pages\/blog\/\[\.\.\.slug\]\/index\.md\.ts\./);
  assert.match(text, /Astro may send requests to this file ahead of src\/pages\/\[\.\.\.slug\]\/index\.md\.ts/);
  assert.doesNotMatch(describeUnreadAgentRoute(unread[0]!, { shadowing: false }), /Astro may send/);
  assert.match(describeUnreadAgentRoute(unread[2]!), /no llms\.txt or llms-full\.txt document is made for it\. Move the call to src\/pages\/llms\.txt\.ts\.$/);
  assert.deepEqual(
    recordMarkdownRoutes(routes, read).map((route) => route.entrypoint).includes("src/pages/all.txt.ts"),
    false,
    "the full-document alias is neither recorded nor reported: the build reads its call",
  );
});
