// The `llms.txt` route factories: prerendered output equals the baked
// payloads, and on request they 404 unknown sections and 500 without details.

import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, test } from "node:test";

import { agentManifest, agentSites, siteApp, srcModule } from "./fixtures/agent-site.ts";

const sites = agentSites();
afterEach(() => sites.cleanup());

const endpoints = srcModule("agent-endpoints.ts");

const CONTENT = {
  "src/content.config.ts": `import { defineCollection } from "astro:content";
import { docsCollection } from ${srcModule("content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  changelog: defineCollection(docsCollection({ base: "changelog" })),
};`,
  "src/content/docs/index.mdx": "---\ntitle: Home\n---\nHome body.\n",
  "src/content/docs/guide.mdx": "---\ntitle: Guide\n---\nGuide body.\n",
  "src/content/changelog/first.mdx": "---\ntitle: First\n---\nFirst entry.\n",
  "src/content/changelog/second.mdx": "---\ntitle: Second\n---\nSecond entry.\n",
};

function routes(prerender: boolean): Record<string, string> {
  return {
    "src/pages/llms.txt.ts": `import { llmsRoute } from ${endpoints};
export const prerender = ${prerender};
export const { GET } = llmsRoute();
`,
    "src/pages/llms-full.txt.ts": `import { llmsFullRoute } from ${endpoints};
export const prerender = ${prerender};
export const { GET } = llmsFullRoute();
`,
    "src/lib/llms.ts": `import { llmsSectionRoute } from ${endpoints};
export const section = llmsSectionRoute();
`,
    "src/pages/[section]/llms.txt.ts": `import { section } from "../../lib/llms";
export const prerender = ${prerender};
export const { GET, getStaticPaths } = section;
`,
  };
}

async function bakedLlms(root: string): Promise<Map<string, string>> {
  const bodies = new Map<string, string>();
  for (const asset of (await agentManifest(root)).llmsAssets) {
    const url =
      asset.scope === "section"
        ? `${asset.section}/llms.txt`
        : asset.surface === "full"
          ? "llms-full.txt"
          : "llms.txt";
    bodies.set(
      url,
      await readFile(path.join(root, ".astro/nimbus/agent-endpoint-assets", asset.path), "utf8"),
    );
  }
  return bodies;
}

test("prerendered factories write every baked llms.txt payload and warn about nothing", async () => {
  const site = await sites.buildSite({ ...CONTENT, ...routes(true) }, { logLevel: "warn" });
  const baked = await bakedLlms(site.root);
  assert.deepEqual([...baked.keys()].sort(), ["changelog/llms.txt", "llms-full.txt", "llms.txt"]);
  for (const [url, body] of baked) {
    assert.equal(await readFile(path.join(site.root, "dist", url), "utf8"), body, url);
  }
  assert.doesNotMatch(site.logs, /not prerendered/);
});

test("factories rendered on request warn, serve by URL, 404 unknown sections, and 500 without details", async () => {
  const site = await sites.buildSite(
    { ...CONTENT, ...routes(false) },
    { server: true, logLevel: "warn" },
  );
  assert.match(
    site.logs,
    /nimbus-docs: 3 Markdown or llms\.txt pages were not prerendered:\n {2}- src\/pages\/\[section\]\/llms\.txt\.ts \(\/\[section\]\/llms\.txt\) is rendered on request, so the build has no file for: \/changelog\/llms\.txt\n {2}- src\/pages\/llms-full\.txt\.ts \(\/llms-full\.txt\) is rendered on request, so the build has no file for: \/llms-full\.txt\n {2}- src\/pages\/llms\.txt\.ts \(\/llms\.txt\) is rendered on request, so the build has no file for: \/llms\.txt\n/,
  );
  const app = await siteApp(site);
  const baked = await bakedLlms(site.root);
  for (const [url, body] of baked) {
    const response = await app.render(new Request(`https://example.test/docs/${url}`));
    assert.equal(response.status, 200, url);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await response.text(), body, url);
  }

  const unknown = await app.render(new Request("https://example.test/docs/unknown/llms.txt"));
  assert.equal(unknown.status, 404);
  assert.equal(await unknown.text(), "Not found");

  const asset = (await agentManifest(site.root)).llmsAssets.find(
    (candidate) => candidate.section === "changelog",
  )!;
  await rm(path.join(site.root, ".astro/nimbus/agent-endpoint-assets", asset.path));
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const logged: unknown[] = [];
  globalThis.fetch = async () => new Response("gone", { status: 503 });
  console.error = (error: unknown) => logged.push(error);
  try {
    const failed = await app.render(new Request("https://example.test/docs/changelog/llms.txt"));
    assert.equal(failed.status, 500);
    assert.match(failed.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(await failed.text(), "Internal Server Error");
    assert.equal(logged.length, 1);
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
});
