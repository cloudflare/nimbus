// API Markdown on request: a request-rendered API collection bakes no page
// Markdown; its `.md` route, the negotiated form and MCP render the document
// from the page record, through the serialization the bake uses, so the
// bytes equal the asset a build-rendered site writes for the same page.
// Server builds for the Cloudflare adapter (by name; the Workers assets
// binding is stubbed to read the client directory).

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";

import { build, type AstroIntegration } from "astro";

import nimbus from "../src/index.ts";
import { runningNimbusVersion } from "../src/_internal/upgrades.ts";
import { TEST_TMP } from "./fixtures/temp-root.js";
import { readRpcResponse, rpcRequest, toolText } from "./fixtures/mcp/rpc.js";

register(new URL("./fixtures/mcp/workers-loader.mjs", import.meta.url));
const assetRoots = ((globalThis as { __nimbusTestAssetRoots?: Map<string, { dir: string; base: string }> }).__nimbusTestAssetRoots ??= new Map());

const SRC_DIR = path.resolve(import.meta.dirname, "../src");

const SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Pets", version: "1.0.0", description: "A pet store." },
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "List pets",
        description: "Every pet, see [the guide](/guide/) for paging.",
        responses: { "200": { description: "ok" } },
      },
      post: {
        operationId: "createPet",
        summary: "Create pet",
        responses: { "201": { description: "created" } },
      },
    },
  },
});

interface SiteOptions {
  host: string;
  rendering: "build" | "request";
  /** Whether `src/pages/llms.txt.ts` exists. */
  llms?: boolean;
  mcp?: boolean;
  /** A site-wide social image, written to every document's frontmatter. */
  socialImage?: string;
  /** Page packs instead of prepared entries (`bundle: false`; needs request rendering). */
  bundle?: false;
  /** The API served at the site root, with no docs collection. */
  atRoot?: boolean;
}

interface Site {
  root: string;
  app: { render(request: Request): Promise<Response> };
  /** How many times the API page's HTML route has run. */
  renders(): Promise<number>;
}

async function buildSite(options: SiteOptions): Promise<Site> {
  // Astro recognises src/live.config.ts by its real path.
  const root = await realpath(await mkdtemp(path.join(TEST_TMP, "nimbus-api-markdown-on-request-")));
  const write = async (relative: string, contents: string) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents, "utf8");
  };
  await symlink(path.resolve(import.meta.dirname, "../node_modules"), path.join(root, "node_modules"), "dir");
  await write("nimbus.json", `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`);
  await write("specs/pets.json", SPEC);
  await write("package.json", '{"type":"module"}\n');
  if (options.bundle === false) {
    await write(
      "src/live.config.ts",
      `import { defineLiveCollection } from "astro:content";
import { apiPagesLoader } from "@cloudflare/nimbus-docs/live";
export const collections = { apiPages: defineLiveCollection({ loader: apiPagesLoader() }) };
`,
    );
  }
  await write(
    "src/content.config.ts",
    `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection } from ${JSON.stringify(pathToFileURL(path.join(SRC_DIR, "content.ts")).href)};
export const collections = {
${options.atRoot ? "" : "  docs: defineCollection(docsCollection()),\n"}  pets: defineCollection(apiCollection()),
};
`,
  );
  if (!options.atRoot) {
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
  }
  // The HTML route counts its runs, so a test can say a negotiated request
  // rendered no HTML.
  const counter = path.join(root, "renders.log");
  await write(
    options.atRoot ? "src/pages/[...slug].astro" : "src/pages/pets/[...slug].astro",
    `---
import { appendFileSync } from "node:fs";
import { getApiRoute, getApiStaticPaths } from "@cloudflare/nimbus-docs/runtime";
export const prerender = true;
export const getStaticPaths = getApiStaticPaths("pets");
const result = await getApiRoute(Astro);
if (result instanceof Response) return result;
if (!Astro.isPrerendered) appendFileSync(${JSON.stringify(counter)}, Astro.url.pathname + "\\n");
const { page } = result;
---
<html><body><main data-title={page.title}>{page.title}</main></body></html>
`,
  );
  await write(
    "src/pages/[...slug]/index.md.ts",
    `import { markdownRoute } from "@cloudflare/nimbus-docs/agent-endpoints";
export const { GET, getStaticPaths } = markdownRoute();
`,
  );
  if (options.llms !== false) {
    await write(
      "src/pages/llms.txt.ts",
      `import { llmsRoute } from "@cloudflare/nimbus-docs/agent-endpoints";
export const { GET } = llmsRoute();
`,
    );
  }
  if (!options.atRoot) await write("src/pages/index.astro", "<html><body><h1>Home</h1></body></html>\n");
  await write("server-entry.mjs", 'import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n');

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
          { find: /^@cloudflare\/nimbus-docs$/, replacement: path.join(SRC_DIR, "index.ts") },
          { find: /^@cloudflare\/nimbus-docs\//, replacement: `${SRC_DIR}/` },
        ],
      },
    },
    site: `https://${options.host}`,
    output: "server",
    adapter,
    integrations: [
      nimbus(
        {
          site: `https://${options.host}`,
          title: "Test",
          description: "Test",
          search: false,
          rendering: { default: "build", collections: { pets: options.rendering } },
          ...(options.mcp ? { agents: { mcp: true } } : {}),
          ...(options.socialImage ? { socialImage: options.socialImage } : {}),
          api: [{ collection: "pets", spec: "./specs/pets.json", ...(options.bundle === false ? { bundle: false } : {}) }],
        } as Parameters<typeof nimbus>[0],
        { admonitions: false, sitemap: false, validateMdx: false },
      ),
    ],
  } as never);
  assetRoots.set(options.host, { dir: path.join(root, "dist"), base: "/" });
  const { app } = (await import(pathToFileURL(path.join(root, ".server/entry.mjs")).href)) as { app: Site["app"] };
  return {
    root,
    app,
    renders: async () => (existsSync(counter) ? (await readFile(counter, "utf8")).split("\n").filter(Boolean).length : 0),
  };
}

interface Manifest {
  markdownAssets: Array<{ collection: string; id: string; url: string; path: string; contentStart: number; contentEnd: number }>;
  rendered: Array<{ collection: string; id: string; url: string; published: boolean }>;
}

const manifestOf = async (site: Site): Promise<Manifest> =>
  JSON.parse(await readFile(path.join(site.root, ".astro/nimbus/agent-endpoint-assets/manifest.json"), "utf8")) as Manifest;

/** The file the build-rendered site's prerendered Markdown route wrote. */
const bakedBody = async (site: Site, url: string): Promise<string> =>
  readFile(path.join(site.root, "dist", ...url.split("/").filter(Boolean)), "utf8");

let baked: Site;
let rendered: Site;
let noIndex: Site;
let imaged: Site;
let packed: Site;
let atRoot: Site;

before(async () => {
  [baked, rendered, noIndex, imaged, packed, atRoot] = await Promise.all([
    buildSite({ host: "baked.test", rendering: "build" }),
    buildSite({ host: "rendered.test", rendering: "request", mcp: true }),
    buildSite({ host: "noindex.test", rendering: "request", llms: false }),
    buildSite({ host: "imaged.test", rendering: "request", socialImage: "/social.png" }),
    buildSite({ host: "packed.test", rendering: "request", bundle: false }),
    buildSite({ host: "atroot.test", rendering: "request", atRoot: true, mcp: true }),
  ]);
});

after(async () => {
  await Promise.all(
    [baked, rendered, noIndex, imaged, packed, atRoot]
      .filter(Boolean)
      .map((site) => rm(site.root, { recursive: true, force: true, maxRetries: 5 })),
  );
});

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
const rehost = (body: string, from: string, to: string) => body.replaceAll(`https://${from}/`, `https://${to}/`);

test("a request-rendered API bakes no page Markdown and describes its pages instead", async () => {
  const manifest = await manifestOf(rendered);
  assert.deepEqual(manifest.markdownAssets.filter((asset) => asset.collection === "pets"), []);
  assert.deepEqual(
    manifest.rendered.map((page) => [page.id, page.url, page.published]).sort(),
    [
      ["index", "/pets/", true],
      ["createPet", "/pets/createPet/", true],
      ["listPets", "/pets/listPets/", true],
    ].sort(),
  );
  // Docs pages are baked as before.
  assert.ok(manifest.markdownAssets.some((asset) => asset.url === "/guide/index.md"));
  // No Markdown of the API reaches the deploy.
  assert.ok(!existsSync(path.join(rendered.root, "dist/_nimbus/agent-endpoint-assets/assets")) ||
    (await manifestOf(rendered)).markdownAssets.every((asset) => asset.collection !== "pets"));
});

test("the .md route renders the bytes the build-rendered site baked, with the document's ETag", async () => {
  for (const url of ["/pets/index.md", "/pets/listPets/index.md", "/pets/createPet/index.md"]) {
    const response = await rendered.app.render(new Request(`https://rendered.test${url}`));
    assert.equal(response.status, 200, url);
    assert.match(response.headers.get("Content-Type") ?? "", /^text\/markdown/);
    const body = await response.text();
    const expected = (await bakedBody(baked, url)).replaceAll("https://baked.test/", "https://rendered.test/");
    assert.equal(body, expected, `${url} equals the baked serialization`);
    assert.match(response.headers.get("ETag") ?? "", /^"sha256:[0-9a-f]{64}"$/);
  }
  // Links the emitter wrote root-relative are absolute against the site.
  const list = await (await rendered.app.render(new Request("https://rendered.test/pets/listPets/index.md"))).text();
  assert.match(list, /\]\(https:\/\/rendered\.test\/guide\/\)/);
});

test("Accept: text/markdown is answered before the page's HTML renders, with the page's Markdown and Vary", async () => {
  const before = await rendered.renders();
  const markdown = await rendered.app.render(
    new Request("https://rendered.test/pets/listPets/", { headers: { Accept: "text/markdown" } }),
  );
  assert.equal(markdown.status, 200);
  assert.match(markdown.headers.get("Content-Type") ?? "", /^text\/markdown/);
  assert.match(markdown.headers.get("Vary") ?? "", /Accept/);
  assert.match(markdown.headers.get("ETag") ?? "", /^"sha256:/);
  const direct = await (await rendered.app.render(new Request("https://rendered.test/pets/listPets/index.md"))).text();
  assert.equal(await markdown.text(), direct, "the negotiated form is the direct URL's bytes");
  assert.equal(await rendered.renders(), before, "the HTML route did not run");

  const html = await rendered.app.render(
    new Request("https://rendered.test/pets/listPets/", { headers: { Accept: "text/html" } }),
  );
  assert.equal(html.status, 200);
  assert.match(html.headers.get("Content-Type") ?? "", /^text\/html/);
  assert.match(html.headers.get("Vary") ?? "", /Accept/);
  assert.equal(await rendered.renders(), before + 1, "a client preferring HTML renders the page once");

  const head = await rendered.app.render(
    new Request("https://rendered.test/pets/listPets/", { method: "HEAD", headers: { Accept: "text/markdown" } }),
  );
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
});

test("the ETag is the document's digest, so any serialization input that changes the bytes changes it", async () => {
  const url = "/pets/listPets/index.md";
  const withIndex = await rendered.app.render(new Request(`https://rendered.test${url}`));
  const withIndexBody = await withIndex.text();
  assert.equal(withIndex.headers.get("ETag"), `"sha256:${await sha256(withIndexBody)}"`);

  // The llms.txt route alone: the same site otherwise, so the two bodies
  // differ only by the index note, and the tags differ.
  const without = await noIndex.app.render(new Request(`https://noindex.test${url}`));
  assert.equal(without.status, 200);
  const withoutBody = await without.text();
  assert.match(withIndexBody, /> Documentation Index/);
  assert.doesNotMatch(withoutBody, /> Documentation Index/);
  const note = /> Documentation Index\n[^\n]*\n[^\n]*\n\n/;
  assert.equal(rehost(withIndexBody, "rendered.test", "noindex.test").replace(note, ""), withoutBody);
  assert.notEqual(withIndex.headers.get("ETag"), without.headers.get("ETag"));

  // A config-only change (the site's social image) with the record unchanged.
  const withImage = await imaged.app.render(new Request(`https://imaged.test${url}`));
  const withImageBody = await withImage.text();
  assert.match(withImageBody, /^---\ntitle: "List pets"\nimage: "https:\/\/imaged\.test\/social\.png"\n---/);
  assert.equal(withImageBody.replace(/^image: .*\n/m, ""), rehost(withIndexBody, "rendered.test", "imaged.test"));
  assert.notEqual(withImage.headers.get("ETag"), withIndex.headers.get("ETag"));

  // The same site answers the same bytes and the same tag again.
  const again = await rendered.app.render(new Request(`https://rendered.test${url}`));
  assert.equal(again.headers.get("ETag"), withIndex.headers.get("ETag"));
});

test("a bundle: false collection renders the same document from its page pack", async () => {
  const manifest = await manifestOf(packed);
  assert.deepEqual(manifest.markdownAssets.filter((asset) => asset.collection === "pets"), []);
  assert.equal(manifest.rendered.length, 3);
  for (const url of ["/pets/index.md", "/pets/listPets/index.md", "/pets/createPet/index.md"]) {
    const response = await packed.app.render(new Request(`https://packed.test${url}`));
    assert.equal(response.status, 200, url);
    const expected = rehost(await (await rendered.app.render(new Request(`https://rendered.test${url}`))).text(), "rendered.test", "packed.test");
    assert.equal(await response.text(), expected, `${url} from the page pack equals the prepared entry's`);
  }
});

test("an API served at the site root renders its overview at /index.md, not the llms index", async () => {
  const manifest = await manifestOf(atRoot);
  assert.ok(manifest.rendered.some((page) => page.url === "/" && page.published), "the overview is described at /");
  const direct = await atRoot.app.render(new Request("https://atroot.test/index.md"));
  assert.equal(direct.status, 200);
  const body = await direct.text();
  assert.match(body, /^---\ntitle: "Pets"\n/);
  assert.match(body, /\nSource: https:\/\/atroot\.test\/index\.md\n$/);
  assert.doesNotMatch(body, /llms-full|\]\(https:\/\/atroot\.test\/llms\.txt\)/, "not the site index");

  const before = await atRoot.renders();
  const negotiated = await atRoot.app.render(new Request("https://atroot.test/", { headers: { Accept: "text/markdown" } }));
  assert.equal(negotiated.status, 200);
  assert.match(negotiated.headers.get("Content-Type") ?? "", /^text\/markdown/);
  assert.equal(await negotiated.text(), body);
  assert.match(negotiated.headers.get("Link") ?? "", /rel="ard"/, "the homepage's discovery links");
  assert.equal(await atRoot.renders(), before, "the HTML route did not run");

  const endpoint = "https://atroot.test/mcp";
  const message = await readRpcResponse(
    await atRoot.app.render(rpcRequest(endpoint, "tools/call", { name: "get_page", arguments: { url: "https://atroot.test/" } })),
  );
  const result = toolText(message) as { content: string };
  assert.ok(result.content.includes("A pet store."), result.content.slice(0, 200));
});

test("MCP get_page reads a rendered page's content, the .md body's content slice", async () => {
  const endpoint = "https://rendered.test/mcp";
  const call = async (tool: string, args: Record<string, unknown>) => {
    const message = await readRpcResponse(await rendered.app.render(rpcRequest(endpoint, "tools/call", { name: tool, arguments: args })));
    assert.equal(message.error, undefined, JSON.stringify(message));
    return toolText(message) as Record<string, unknown>;
  };
  const listed = (await call("list_pages", {})) as { pages: Array<{ url: string; markdownUrl?: string }> };
  const page = listed.pages.find((candidate) => candidate.url === "https://rendered.test/pets/listPets/");
  assert.ok(page, "the API page is listed");
  assert.equal(page.markdownUrl, "https://rendered.test/pets/listPets/index.md");
  const result = (await call("get_page", { url: page.url })) as { content: string };
  const direct = await (await rendered.app.render(new Request("https://rendered.test/pets/listPets/index.md"))).text();
  const content = direct.slice(direct.indexOf("\n# List pets\n") + "\n# List pets\n\n".length, direct.lastIndexOf("\n\nSource: "));
  assert.equal(result.content, content);
});
