import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "astro";

import { discoveryFixture as fixture } from "./fixtures/agent-discovery-site.js";
import { srcModule, testAdapter } from "./fixtures/agent-site.js";

type App = { render(request: Request): Promise<Response> };

async function serverBuild(
  site: Awaited<ReturnType<typeof fixture>>,
): Promise<App> {
  await site.write(
    "server-entry.mjs",
    'import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n',
  );
  await build({
    ...site.config,
    output: "server",
    adapter: testAdapter(path.join(site.root, "server-entry.mjs")),
    build: {
      client: path.join(site.root, "dist"),
      server: path.join(site.root, ".server"),
    },
  } as never);
  const { app } = (await import(
    pathToFileURL(path.join(site.root, ".server", "entry.mjs")).href
  )) as { app: App };
  return app;
}

test("request-rendered Markdown is reached through the in-process rewrite on a non-Cloudflare server", async () => {
  // `rendering.default: "request"` with the copied starter route files
  // (factory calls, `export const prerender = true`): the policy wins, the
  // Markdown routes render on request, and negotiation reaches them through
  // `context.rewrite`, never the origin fetch.
  const site = await fixture("---\ntitle: Root entry\n---\nHome body.", "docs", false, undefined, {
    rendering: { default: "request" },
  });
  try {
    await site.write(
      "src/pages/[...slug].astro",
      `---\nimport { getDocsPage } from ${srcModule("index.ts")};\nconst page = await getDocsPage(Astro);\nif (page instanceof Response) return page;\nAstro.response.headers.set("X-Owner", "page");\n---\n<html><body>Page</body></html>`,
    );
    await site.write(
      "src/pages/llms-full.txt.ts",
      `import { llmsFullRoute } from ${srcModule("agent-endpoints.ts")};\nexport const prerender = true;\nexport const { GET } = llmsFullRoute();\n`,
    );
    const app = await serverBuild(site);
    // Criterion: no public files at the agent URLs.
    assert.ok(!existsSync(path.join(site.root, "dist/guide/index.md")));
    assert.ok(!existsSync(path.join(site.root, "dist/llms.txt")));

    const direct = await app.render(
      new Request("https://example.test/docs/guide/index.md"),
    );
    assert.equal(direct.status, 200);
    const expected = await direct.text();
    assert.match(expected, /Hello discovery/);

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("negotiation must not fetch the origin");
    }) as typeof fetch;
    try {
      const negotiated = await app.render(
        new Request("https://example.test/docs/guide/", {
          headers: { Accept: "text/markdown" },
        }),
      );
      assert.equal(negotiated.status, 200);
      assert.match(negotiated.headers.get("Content-Type") ?? "", /text\/markdown/);
      assert.match(negotiated.headers.get("Vary") ?? "", /Accept/);
      assert.equal(negotiated.headers.get("X-Owner"), "page");
      assert.equal(await negotiated.text(), expected);
    } finally {
      globalThis.fetch = realFetch;
    }

    // llms.txt follows the default too: served on request, same payload as
    // the baked asset.
    const llms = await app.render(new Request("https://example.test/docs/llms.txt"));
    assert.equal(llms.status, 200);
    assert.match(await llms.text(), /Hello discovery|Guide/);
    assert.ok(!existsSync(path.join(site.root, "dist/llms-full.txt")));
    const full = await app.render(
      new Request("https://example.test/docs/llms-full.txt"),
    );
    assert.equal(full.status, 200);
    assert.match(await full.text(), /Hello discovery/);
  } finally {
    await rm(site.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("a request-rendered /index.md with a prebuilt /llms.txt and no root entry serves the site llms index", async () => {
  // The homepage-fallback table's fourth row: `docs: "request"` makes the
  // root Markdown route render on request while `rendering.default: "build"`
  // keeps /llms.txt prebuilt. A rewrite to a prebuilt route is forbidden, so
  // the root Markdown factory serves Nimbus's site llms payload itself.
  const site = await fixture(undefined, "docs", false, undefined, {
    rendering: { default: "build", collections: { docs: "request" } },
  });
  try {
    await site.write(
      "src/pages/[...slug].astro",
      `---\nimport { getDocsPage } from ${srcModule("index.ts")};\nconst page = await getDocsPage(Astro);\nif (page instanceof Response) return page;\n---\n<html><body>Page</body></html>`,
    );
    const app = await serverBuild(site);
    const llmsFile = await readFile(path.join(site.root, "dist/llms.txt"), "utf8");
    assert.ok(!existsSync(path.join(site.root, "dist/index.md")));
    const homepage = await app.render(
      new Request("https://example.test/docs/index.md"),
    );
    assert.equal(homepage.status, 200);
    assert.match(homepage.headers.get("Content-Type") ?? "", /text\/markdown/);
    assert.equal(await homepage.text(), llmsFile);
  } finally {
    await rm(site.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("a mounted version collection follows its own mode while the root stays prebuilt", async () => {
  // `default: "request"` with `docs: "build"`: the root agent routes take
  // the root collection's mode (prebuilt); the mounted version collection
  // inherits the default through its own injected routes (on request).
  const site = await fixture("---\ntitle: Root entry\n---\nHome body.", "docs", false, undefined, {
    versions: { current: "v2", others: ["v1"] },
    rendering: { default: "request", collections: { docs: "build", "docs-v1": "request" } },
  });
  try {
    await site.write(
      "src/content.config.ts",
      `import { defineCollection } from "astro:content"; import { docsCollection } from ${JSON.stringify(
        pathToFileURL(path.resolve(import.meta.dirname, "../src/content.ts")).href,
      )};\nexport const collections = { docs: defineCollection(docsCollection()), "docs-v1": defineCollection(docsCollection({ base: "docs-v1" })) };`,
    );
    await site.write(
      "src/content/docs-v1/old.mdx",
      "---\ntitle: Old guide\n---\nOld body.",
    );
    // The injected mounted routes mirror the root agent routes the project
    // has; the fixture adds the section index so /v1/llms.txt has a mirror.
    await site.write(
      "src/pages/[section]/llms.txt.ts",
      `import { llmsSectionRoute } from ${JSON.stringify(
        pathToFileURL(path.resolve(import.meta.dirname, "../src/agent-endpoints.ts")).href,
      )};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = llmsSectionRoute();\n`,
    );
    await site.write(
      "src/pages/[...slug].astro",
      `---\nimport { getDocsStaticPaths, getDocsPageProps } from ${srcModule("index.ts")};\nexport const prerender = true;\nexport const getStaticPaths = getDocsStaticPaths;\nconst { entry } = await getDocsPageProps(Astro);\n---\n<html><body>Page</body></html>`,
    );
    await site.write(
      "src/pages/v1/[...slug].astro",
      `---\nimport { getCollectionPage } from ${srcModule("index.ts")};\nconst page = await getCollectionPage(Astro);\nif (page instanceof Response) return page;\n---\n<html><body>Old page</body></html>`,
    );
    const app = await serverBuild(site);
    // Root Markdown and homepage Markdown are prebuilt (root mode "build").
    assert.ok(existsSync(path.join(site.root, "dist/guide/index.md")));
    assert.ok(existsSync(path.join(site.root, "dist/index.md")));
    // The mounted version's Markdown is not prebuilt and serves on request
    // through its injected route.
    assert.ok(!existsSync(path.join(site.root, "dist/v1")));
    const old = await app.render(
      new Request("https://example.test/docs/v1/old/index.md"),
    );
    assert.equal(old.status, 200);
    assert.match(old.headers.get("Content-Type") ?? "", /text\/markdown/);
    assert.match(await old.text(), /Old body/);
    const sectionIndex = await app.render(
      new Request("https://example.test/docs/v1/llms.txt"),
    );
    assert.equal(sectionIndex.status, 200);
    assert.match(await sectionIndex.text(), /Old guide/);
    // Unknown Markdown URLs still 404 in every mode.
    const unknown = await app.render(
      new Request("https://example.test/docs/v1/missing/index.md"),
    );
    assert.equal(unknown.status, 404);
  } finally {
    await rm(site.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("an all-build policy leaves mounted URLs to the root route, customization included", async () => {
  // With everything prerendered, no route is injected: the root route keeps
  // emitting the mount's files at build time, so a wrapped root route's
  // customization reaches them exactly as on a site without `rendering`.
  const site = await fixture("---\ntitle: Root entry\n---\nHome body.", "docs", false, undefined, {
    versions: { current: "v2", others: ["v1"] },
    rendering: { default: "build" },
  });
  try {
    await site.write(
      "src/content.config.ts",
      `import { defineCollection } from "astro:content"; import { docsCollection } from ${JSON.stringify(
        pathToFileURL(path.resolve(import.meta.dirname, "../src/content.ts")).href,
      )};\nexport const collections = { docs: defineCollection(docsCollection()), "docs-v1": defineCollection(docsCollection({ base: "docs-v1" })) };`,
    );
    await site.write(
      "src/content/docs-v1/old.mdx",
      "---\ntitle: Old guide\n---\nOld body.",
    );
    await site.write(
      "src/pages/[...slug].astro",
      `---\nimport { getDocsStaticPaths, getDocsPageProps } from ${srcModule("index.ts")};\nexport const prerender = true;\nexport const getStaticPaths = getDocsStaticPaths;\nconst { entry } = await getDocsPageProps(Astro);\n---\n<html><body>Page</body></html>`,
    );
    await site.write(
      "src/pages/v1/[...slug].astro",
      `---\nimport { getCollectionStaticPaths, getCollectionPageProps } from ${srcModule("index.ts")};\nexport const prerender = true;\nexport const getStaticPaths = getCollectionStaticPaths("docs-v1");\nconst { entry } = await getCollectionPageProps(Astro);\n---\n<html><body>Old page</body></html>`,
    );
    // A wrapped root Markdown route: its customization must reach the
    // mounted version's URLs, which it still owns.
    // (Page routes under an all-build policy prerender via static paths.)
    await site.write(
      "src/pages/[...slug]/index.md.ts",
      `import { markdownRoute } from ${srcModule("agent-endpoints.ts")};
export const prerender = true;
const shared = markdownRoute();
export const getStaticPaths = shared.getStaticPaths;
export async function GET(context) {
  const response = await shared.GET(context);
  if (!response.ok) return response;
  return new Response("<!-- custom -->\\n" + (await response.text()), {
    headers: response.headers,
  });
}
`,
    );
    await serverBuild(site);
    const body = await readFile(
      path.join(site.root, "dist/v1/old/index.md"),
      "utf8",
    );
    assert.match(body, /^<!-- custom -->/);
    assert.match(body, /Old body/);
  } finally {
    await rm(site.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("a prebuilt mount with no discoverable pages emits no llms.txt and builds", async () => {
  // Case: root on request, mounted version prebuilt, and every page in the
  // mount is noindex — there is no section index to emit, and the build
  // neither fails nor writes a bogus file (the injected route's dynamic
  // pattern emits nothing, like the shared section route for an absent
  // section).
  const site = await fixture("---\ntitle: Root entry\n---\nHome body.", "docs", false, undefined, {
    versions: { current: "v2", others: ["v1"] },
    rendering: { default: "build", collections: { docs: "request" } },
  });
  try {
    await site.write(
      "src/content.config.ts",
      `import { defineCollection } from "astro:content"; import { docsCollection } from ${JSON.stringify(
        pathToFileURL(path.resolve(import.meta.dirname, "../src/content.ts")).href,
      )};\nexport const collections = { docs: defineCollection(docsCollection()), "docs-v1": defineCollection(docsCollection({ base: "docs-v1" })) };`,
    );
    await site.write(
      "src/content/docs-v1/old.mdx",
      "---\ntitle: Old guide\nnoindex: true\n---\nOld body.",
    );
    await site.write(
      "src/pages/[section]/llms.txt.ts",
      `import { llmsSectionRoute } from ${JSON.stringify(
        pathToFileURL(path.resolve(import.meta.dirname, "../src/agent-endpoints.ts")).href,
      )};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = llmsSectionRoute();\n`,
    );
    await site.write(
      "src/pages/[...slug].astro",
      `---\nimport { getDocsPage } from ${srcModule("index.ts")};\nconst page = await getDocsPage(Astro);\nif (page instanceof Response) return page;\n---\n<html><body>Page</body></html>`,
    );
    await site.write(
      "src/pages/v1/[...slug].astro",
      `---\nimport { getCollectionStaticPaths, getCollectionPageProps } from ${srcModule("index.ts")};\nexport const prerender = true;\nexport const getStaticPaths = getCollectionStaticPaths("docs-v1");\nconst { entry } = await getCollectionPageProps(Astro);\n---\n<html><body>Old page</body></html>`,
    );
    await serverBuild(site);
    assert.ok(!existsSync(path.join(site.root, "dist/v1/llms.txt")));
    // The mounted Markdown stays prebuilt for the noindex page (noindex
    // pages keep their Markdown, they just leave discovery).
    assert.ok(existsSync(path.join(site.root, "dist/v1/old/index.md")));
  } finally {
    await rm(site.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("a mount sharing the root's request mode is served by the root module, customization included", async () => {
  // Full-request policy: the injected mounted route reuses the project's own
  // wrapped root Markdown module, so its customization reaches the mount's
  // URLs with the same bytes a static build would emit.
  const site = await fixture("---\ntitle: Root entry\n---\nHome body.", "docs", false, undefined, {
    versions: { current: "v2", others: ["v1"] },
    rendering: { default: "request" },
  });
  try {
    await site.write(
      "src/content.config.ts",
      `import { defineCollection } from "astro:content"; import { docsCollection } from ${JSON.stringify(
        pathToFileURL(path.resolve(import.meta.dirname, "../src/content.ts")).href,
      )};\nexport const collections = { docs: defineCollection(docsCollection()), "docs-v1": defineCollection(docsCollection({ base: "docs-v1" })) };`,
    );
    await site.write(
      "src/content/docs-v1/old.mdx",
      "---\ntitle: Old guide\n---\nOld body.",
    );
    await site.write(
      "src/pages/[...slug].astro",
      `---\nimport { getDocsPage } from ${srcModule("index.ts")};\nconst page = await getDocsPage(Astro);\nif (page instanceof Response) return page;\n---\n<html><body>Page</body></html>`,
    );
    await site.write(
      "src/pages/v1/[...slug].astro",
      `---\nimport { getCollectionPage } from ${srcModule("index.ts")};\nconst page = await getCollectionPage(Astro);\nif (page instanceof Response) return page;\n---\n<html><body>Old page</body></html>`,
    );
    await site.write(
      "src/pages/[...slug]/index.md.ts",
      `import { markdownRoute } from ${srcModule("agent-endpoints.ts")};
export const prerender = true;
const shared = markdownRoute();
export const getStaticPaths = shared.getStaticPaths;
export async function GET(context) {
  const response = await shared.GET(context);
  if (!response.ok) return response;
  return new Response("<!-- custom " + context.params.slug + " -->\\n" + (await response.text()), {
    headers: response.headers,
  });
}
`,
    );
    const app = await serverBuild(site);
    assert.ok(!existsSync(path.join(site.root, "dist/v1/old/index.md")));
    const old = await app.render(
      new Request("https://example.test/docs/v1/old/index.md"),
    );
    assert.equal(old.status, 200);
    const body = await old.text();
    // The wrapper sees the same params a static build gives it — the full
    // slug including the mount segment — so params-reading customizations
    // stay byte-identical too.
    assert.match(body, /^<!-- custom v1\/old -->/);
    assert.match(body, /Old body/);
    const rootPage = await app.render(
      new Request("https://example.test/docs/guide/index.md"),
    );
    assert.match(await rootPage.text(), /^<!-- custom guide -->/);
  } finally {
    await rm(site.root, { recursive: true, force: true, maxRetries: 5 });
  }
});
