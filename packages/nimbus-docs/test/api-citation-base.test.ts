// Prose `api.ref:` citations must carry Astro's `base` in every output: the
// HTML from `.mdx` (Vite source plugin) and `.md` (Markdown processor), both
// prerendered and request-rendered, the Markdown alternate, and `llms-full.txt`.
// The citation index itself stays base-relative; each output applies the base
// exactly once.

import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
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
import { runningNimbusVersion } from "../src/_internal/upgrades.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

const moduleUrl = (relative: string) =>
  JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, relative)).href);

const GUIDE = `---
title: Guide
---
Bare [bare link](api.ref:api:create).

Angle [angle link](<api.ref:api:list>).

<a href="api.ref:api:openDispute">jsx link</a>

Versioned [versioned link](api.ref:api@v1:search).

Plain [plain link](/guide).

Code \`[kept](api.ref:api:create)\`.
`;

const REFERENCE_MD = `---
title: Reference
---
Markdown [md bare link](api.ref:api:create).

Markdown [md angle link](<api.ref:api:list>).

<a href="api.ref:api:openDispute">md html link</a>

Markdown [md versioned link](api.ref:api@v1:search).
`;

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

interface Built {
  root: string;
  html: string;
  markdown: string;
  mdMarkdown: string;
  llmsFull: string;
  requestHtml?: string;
}

async function buildFixture(
  base: string,
  options: { request?: boolean } = {},
): Promise<Built> {
  // Deliberately not realpath'd: macOS tmpdir is a symlink, so this also
  // proves citation scoping survives a symlinked project root.
  const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-citation-base-"));
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
  const api = [
    {
      collection: "api",
      versions: [
        { version: "v2", default: true, spec },
        { version: "v1", spec },
      ],
    },
  ];
  await write(
    "src/content.config.ts",
    `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection } from ${moduleUrl("../src/content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  api: defineCollection(apiCollection(${JSON.stringify(api[0])})),
};`,
  );
  await write("src/content/docs/guide.mdx", GUIDE);
  await write("src/content/docs/reference.md", REFERENCE_MD);
  const renderGuide = `import { getEntry, render } from "astro:content";
const { Content } = await render(await getEntry("docs", "guide"));
const { Content: Reference } = await render(await getEntry("docs", "reference"));
---
<Content />
<Reference />`;
  await write("src/pages/index.astro", `---\nexport const prerender = true;\n${renderGuide}`);
  await write(
    "src/pages/[...slug]/index.md.ts",
    `import { getMarkdownPayload } from ${moduleUrl("../src/agent-endpoints.ts")};
import { getPreparedMarkdownRouteStaticPaths } from ${moduleUrl("../src/publication.ts")};
export const prerender = true;
export const getStaticPaths = () => getPreparedMarkdownRouteStaticPaths({ collection: "docs", surface: "markdown" });
export async function GET({ params, props, request }) {
  const payload = await getMarkdownPayload({ collection: "docs", surface: "markdown", slug: params.slug, reference: props.artifact, context: { request } });
  return new Response(payload.body, { headers: { "content-type": payload.mediaType } });
}`,
  );
  await write(
    "src/pages/llms-full.txt.ts",
    `import { getLlmsPayload } from ${moduleUrl("../src/agent-endpoints.ts")};
export const prerender = true;
export async function GET({ request }) {
  const payload = await getLlmsPayload({ scope: "site", surface: "full" }, { request });
  return new Response(payload.body, { headers: { "content-type": payload.mediaType } });
}`,
  );
  let adapter: AstroIntegration | undefined;
  if (options.request) {
    await write("src/pages/live.astro", `---\nexport const prerender = false;\n${renderGuide}`);
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
    base,
    ...(adapter ? { output: "server" as const, adapter } : {}),
    logLevel: "silent",
    integrations: [
      nimbus(
        {
          site: "https://example.test",
          title: "Test",
          description: "Test",
          search: false,
          api,
        },
        { admonitions: false, sitemap: false, validateMdx: false },
      ),
    ],
  });

  const built: Built = {
    root,
    html: await readFile(path.join(root, "dist/index.html"), "utf8"),
    markdown: await readFile(path.join(root, "dist/guide/index.md"), "utf8"),
    mdMarkdown: await readFile(path.join(root, "dist/reference/index.md"), "utf8"),
    llmsFull: await readFile(path.join(root, "dist/llms-full.txt"), "utf8"),
  };
  if (options.request) {
    const { app } = (await import(
      pathToFileURL(path.join(root, ".server/entry.mjs")).href
    )) as { app: { render(request: Request): Promise<Response> } };
    const prefix = base === "/" ? "" : base;
    const response = await app.render(new Request(`https://example.test${prefix}/live`));
    assert.equal(response.status, 200);
    built.requestHtml = await response.text();
  }
  return built;
}

function hrefs(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of html.matchAll(/<a href="([^"]*)"[^>]*>([^<]+)<\/a>/g)) {
    out[match[2]!] = match[1]!;
  }
  return out;
}

const EXPECTED_ROOT = {
  "bare link": "/api/charges/create",
  "angle link": "/api/charges/list",
  "jsx link": "/api/disputes/openDispute",
  "versioned link": "/api/v1/search/search",
  "plain link": "/guide",
  "md bare link": "/api/charges/create",
  "md angle link": "/api/charges/list",
  "md html link": "/api/disputes/openDispute",
  "md versioned link": "/api/v1/search/search",
};

function expected(prefix: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(EXPECTED_ROOT).map(([label, href]) => [label, `${prefix}${href}`]),
  );
}

test("prose citations carry a non-root base in HTML, Markdown, and llms-full.txt", async () => {
  const built = await buildFixture("/docs", { request: true });

  assert.deepEqual(hrefs(built.html), expected("/docs"));
  assert.deepEqual(hrefs(built.requestHtml!), expected("/docs"));
  assert.match(built.html, /<code>\[kept\]\(api\.ref:api:create\)<\/code>/);

  for (const markdown of [built.markdown, built.llmsFull]) {
    assert.match(markdown, /\[bare link\]\(\/docs\/api\/charges\/create\)/);
    assert.match(markdown, /\[angle link\]\(\/docs\/api\/charges\/list\)/);
    assert.match(markdown, /href="\/docs\/api\/disputes\/openDispute"/);
    assert.match(markdown, /\[versioned link\]\(\/docs\/api\/v1\/search\/search\)/);
  }
  for (const markdown of [built.mdMarkdown, built.llmsFull]) {
    assert.match(markdown, /\[md bare link\]\(\/docs\/api\/charges\/create\)/);
    assert.match(markdown, /\[md angle link\]\(\/docs\/api\/charges\/list\)/);
    assert.match(markdown, /href="\/docs\/api\/disputes\/openDispute">md html link/);
    assert.match(markdown, /\[md versioned link\]\(\/docs\/api\/v1\/search\/search\)/);
  }
  for (const output of [
    built.html,
    built.requestHtml!,
    built.markdown,
    built.mdMarkdown,
    built.llmsFull,
  ]) {
    assert.doesNotMatch(output, /\/docs\/docs\//);
  }
});

test("prose citations resolve without a prefix on a root base", async () => {
  const built = await buildFixture("/");

  assert.deepEqual(hrefs(built.html), expected(""));
  assert.match(built.markdown, /\[bare link\]\(\/api\/charges\/create\)/);
  assert.match(built.markdown, /\[versioned link\]\(\/api\/v1\/search\/search\)/);
  assert.match(built.llmsFull, /\[angle link\]\(\/api\/charges\/list\)/);
  assert.match(built.mdMarkdown, /\[md bare link\]\(\/api\/charges\/create\)/);
});
