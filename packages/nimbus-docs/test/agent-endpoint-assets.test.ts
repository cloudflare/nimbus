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

import {
  beginPreparedMarkdownLoad,
  beginPreparedMarkdownSession,
  clearPreparedMarkdownRegistry,
  commitPreparedMarkdownCollection,
  markPreparedMarkdownRevision,
  preparedMarkdownRootKey,
  runPreparedMarkdownTransaction,
} from "../src/_internal/prepared-markdown-registry.ts";
import {
  AGENT_ENDPOINT_ASSET_GENERATION,
  bakePreparedHeadings,
  bakeAgentEndpointAssets,
  configureAgentEndpointAssetRoot,
  ensureAgentEndpointAssets,
  invalidateAgentEndpointAssets,
  isAgentEndpointAssetRequested,
  agentEndpointAssetLoaderPlugin,
  agentEndpointAssetsRuntimePlugin,
  preparedHeadingsPlugin,
  readLlmsEndpointPayload,
  readMarkdownEndpointPayload,
  registerAgentEndpointAssetDemand,
  removeAgentEndpointAssets,
  stageAgentEndpointAssets,
} from "../src/_internal/agent-endpoint-assets.ts";
import { collectionUrlsKey } from "../src/_internal/collection-mount.ts";
import { renderApiPageMarkdown } from "../src/_internal/api/markdown.ts";
import { fromMarkdown } from "mdast-util-from-markdown";

const roots: string[] = [];
const capability = { generation: AGENT_ENDPOINT_ASSET_GENERATION, base: "/docs" };

afterEach(async () => {
  clearPreparedMarkdownRegistry();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "nimbus-agent-endpoint-assets-"));
  roots.push(value);
  beginPreparedMarkdownSession(value);
  return value;
}

function configure(
  projectRoot: string,
  options: Parameters<typeof bakeAgentEndpointAssets>[0],
): void {
  configureAgentEndpointAssetRoot(projectRoot, "build", () =>
    bakeAgentEndpointAssets(options),
  );
}

function commit(
  root: string,
  collection: string,
  entries: Array<{
    id: string;
    body?: string;
    filePath?: string;
    data?: Record<string, unknown>;
    headings?: Array<{ depth: number; text: string; slug: string }>;
  }>,
  urls?: string,
): void {
  const key = preparedMarkdownRootKey(root);
  const epoch = beginPreparedMarkdownLoad(key, collection, false);
  assert.equal(
    commitPreparedMarkdownCollection(
      key,
      collection,
      epoch,
      urls === undefined ? capability : { ...capability, urls },
      entries.map((entry) => ({
        id: entry.id,
        body: entry.body,
        filePath: entry.filePath,
        data: { ...entry.data },
      })) as never,
      new Map(entries.map((entry) => [entry.id, entry.headings ?? []])),
      collection === "partials" ? "partials" : "page",
    ),
    true,
  );
}

const apiPage = (title: string) => ({
  collection: "api",
  id: "index",
  data: {
    title,
    coordinate: "api",
    prepared: {
      version: 2,
      navEntryId: "index",
      page: {
        kind: "api",
        deprecated: false,
        breadcrumbs: [],
        description: title,
        version: null,
        servers: [],
        sections: [],
      },
    },
  },
});

test("bakes API discovery from thin entries through the projection callback", async () => {
  const projectRoot = await root();
  const entry = {
    collection: "api",
    id: "charges/create",
    data: {
      title: "Create charge",
      description: "Creates a charge.",
      coordinate: "createCharge",
    },
  };
  const calls: string[] = [];
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
    apiEntries: [entry],
    renderApiEntryMarkdown: async (candidate: typeof entry, base: string) => {
      calls.push(`${candidate.collection}:${candidate.id}:${base}`);
      return "# Create charge\n\nCreates a charge.\n";
    },
  };

  configure(projectRoot, options);
  await bakeAgentEndpointAssets(options);

  assert.deepEqual(calls, ["api:charges/create:/docs"]);
  const full = await readLlmsEndpointPayload(projectRoot, {
    scope: "site",
    surface: "full",
  });
  assert.match(full.body, /# Create charge/);
  assert.match(full.body, /Creates a charge\./);
});

test("bakes compact headings with a revisioned partial resolver", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    {
      id: "guide",
      body: '<Render file="snippet" product="bots" />',
      headings: [],
      data: { title: "Guide" },
    },
  ]);
  commit(projectRoot, "partials", [
    {
      id: "bots/snippet",
      body: "## Product heading",
      headings: [
        { depth: 2, text: "Product heading", slug: "product-heading" },
      ],
    },
  ]);
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
    partialResolver: {
      revision: "product-v1",
      resolve: ({ file, product }: { file: string; product?: string }) =>
        product ? `${product}/${file}` : file,
    },
  };
  configure(projectRoot, options);
  const manifest = await bakeAgentEndpointAssets(options);
  assert.deepEqual(manifest.headings, [
    {
      collection: "docs",
      id: "guide",
      generation: 1,
      base: "/docs",
      headings: [
        { depth: 2, text: "Product heading", slug: "product-heading" },
      ],
    },
  ]);
  assert.match(
    (
      await readMarkdownEndpointPayload(projectRoot, {
        collection: "docs",
        id: "guide",
        surface: "source",
      })
    ).body,
    /## Product heading/,
  );
});

test("does not expand literal Render elements in Markdown headings", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    {
      id: "guide",
      filePath: "src/content/docs/guide.md",
      body: '# Guide\n\n<Render file="snippet" />',
      headings: [{ depth: 1, text: "Guide", slug: "guide" }],
    },
  ]);
  commit(projectRoot, "partials", [
    {
      id: "snippet",
      body: "## Partial heading",
      headings: [
        { depth: 2, text: "Partial heading", slug: "partial-heading" },
      ],
    },
  ]);

  const records = await bakePreparedHeadings({
    root: projectRoot,
    base: "/docs",
  });
  assert.deepEqual(records[0]?.headings, [
    { depth: 1, text: "Guide", slug: "guide" },
  ]);
});

test("bakes expanded source and transformed Markdown endpoint assets deterministically", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    {
      id: "guide",
      body: '# Guide\n\n<Render file="outer" params={{ label: "\\u{1F600}", hex: 0x10, fraction: .5, sparse: [, "x"] }} />\n\n<Catalog href="/docs/catalog" />\n\n<Catalog.Item href="/nested" />\n\n<CatalogXItem href="/wrong" />\n\n[API](api.ref:api:list)',
      data: { title: "Guide", description: "Read me" },
    },
  ]);
  commit(projectRoot, "partials", [
    {
      id: "outer",
      body: '😀 Hello {props.label}.\n\n<Render file="inner" params={{ heading: props.label }} />',
      data: { params: ["label", "hex?", "fraction?", "sparse?"] },
    },
    {
      id: "inner",
      body: "## {props.heading}\n\n[Home](/docs/)",
      data: { params: ["heading"] },
    },
  ]);

  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
    socialImage: "/og.png",
    citationIndex: new Map([["api:list", "/api/list"]]),
    componentMap: {
      Catalog: {
        revision: "catalog-v1",
        render: ({
          attrs,
          base,
        }: {
          attrs: Record<string, string | boolean>;
          base: string;
        }) => `[Catalog](${base}:${String(attrs.href)})`,
      },
      "Catalog.Item": {
        revision: "catalog-item-v1",
        render: ({ attrs }: { attrs: Record<string, string | boolean> }) =>
          `[Nested](${String(attrs.href)})`,
      },
    },
  };
  configure(projectRoot, options);
  const first = await bakeAgentEndpointAssets(options);
  const second = await bakeAgentEndpointAssets(options);
  assert.deepEqual(second, first);
  assert.equal(first.markdownAssets.length, 2);
  assert.equal(first.llmsAssets.length, 2);

  const source = await readMarkdownEndpointPayload(projectRoot, {
    collection: "docs",
    id: "guide",
    surface: "source",
  });
  assert.match(source.body, /Hello 😀\./);
  assert.match(source.body, /## 😀/);
  assert.doesNotMatch(source.body, /<Render/);
  assert.equal(source.mediaType, "text/mdx; charset=utf-8");

  const markdown = await readMarkdownEndpointPayload(projectRoot, {
    collection: "docs",
    id: "guide",
    surface: "markdown",
  });
  // Root-relative links are absolute in Markdown, so they resolve wherever it's read.
  assert.match(markdown.body, /\[Catalog\]\(https:\/\/example\.test\/docs:\/docs\/catalog\)/);
  assert.equal(markdown.mediaType, "text/markdown; charset=utf-8");
  assert.match(markdown.body, /\[Nested\]\(https:\/\/example\.test\/nested\)/);
  assert.doesNotMatch(markdown.body, /wrong/);
  assert.match(markdown.body, /\[API\]\(https:\/\/example\.test\/docs\/api\/list\/\)/);
  assert.match(
    markdown.body,
    /image: "https:\/\/example\.test\/docs\/og\.png"/,
  );
  assert.match(
    markdown.body,
    /Source: https:\/\/example\.test\/docs\/guide\/index\.mdx/,
  );
  assert.doesNotMatch(markdown.body, /__nimbusMarkdown/);
  assert.match(markdown.content, /\[Catalog\]\(https:\/\/example\.test\/docs:\/docs\/catalog\)/);
  assert.doesNotMatch(markdown.content, /Documentation Index|Source:|^---/m);

  const manifest = await readFile(
    path.join(projectRoot, ".astro/nimbus/agent-endpoint-assets/manifest.json"),
    "utf8",
  );
  assert.equal(manifest, `${JSON.stringify(first, null, 2)}\n`);
});

test("a section takes its index page's sidebar group label, then its title", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    {
      id: "guide",
      body: "Overview",
      data: { title: "Guides overview", description: "How to do things.", sidebar: { group: { label: "Guides" } } },
    },
    { id: "guide/a", body: "Guide A", data: { title: "Guide A" } },
    { id: "ref", body: "Reference", data: { title: "Reference home" } },
    { id: "ref/a", body: "Ref A", data: { title: "Ref A" } },
  ]);
  const options = { root: projectRoot, base: "/docs", site: "https://example.test", title: "Test" };
  configure(projectRoot, options);
  await bakeAgentEndpointAssets(options);
  const index = await readLlmsEndpointPayload(projectRoot, { scope: "site", surface: "index" });
  assert.match(index.body, /\[Guides\]\(https:\/\/example\.test\/docs\/guide\/llms\.txt\)/);
  assert.match(index.body, /\[Reference home\]\(https:\/\/example\.test\/docs\/ref\/llms\.txt\)/);
  // A section's summary is its index page's description, when it has one.
  const guide = await readLlmsEndpointPayload(projectRoot, { scope: "section", surface: "index", section: "guide" });
  assert.match(guide.body, /^# Guides\n\n> How to do things\.\n\n## Pages\n/);
  const ref = await readLlmsEndpointPayload(projectRoot, { scope: "section", surface: "index", section: "ref" });
  assert.match(ref.body, /^# Reference home\n\n## Pages\n/);
});

test("bakes site and section llms.txt endpoint assets from public discoverable prose and API pages", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "guide/a", body: "Guide A", data: { title: "Guide A" } },
    {
      id: "guide/b",
      body: "<Card>Guide B</Card>",
      data: { title: "Guide B", description: "Second guide" },
    },
    { id: "leaf", body: "Leaf", data: { title: "Leaf" } },
    {
      id: "hidden",
      body: "Hidden",
      data: { title: "Hidden", noindex: true },
    },
  ]);
  commit(projectRoot, "docs-v1", [
    { id: "old", body: "Old", data: { title: "Old" } },
  ]);
  commit(projectRoot, "blog", [
    { id: "post", body: "Post", data: { title: "Post" } },
  ]);
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
    description: "Test docs",
    versions: { current: "current", others: ["v1"], hidden: ["v1"] },
    componentMap: {
      Card: {
        revision: "card-v1",
        render: ({ children }: { children: string }) => `**${children}**`,
      },
    },
    apiEntries: [
      {
        collection: "api",
        id: "index",
        hidden: false,
        data: {
          title: "API",
          version: "v1",
          coordinate: "api",
          prepared: {
            version: 2,
            navEntryId: "index",
            page: {
              kind: "api",
              deprecated: false,
              breadcrumbs: [],
              description: "API reference",
              version: "1",
              servers: [],
              sections: [
                { label: "Users", href: "/api/tags/users" },
              ],
            },
          },
        },
      },
      {
        collection: "api",
        id: "v2",
        hidden: true,
        data: { title: "Secret API", version: "v2" },
      },
    ],
  };
  configure(projectRoot, options);
  const manifest = await bakeAgentEndpointAssets(options);
  assert.deepEqual(
    manifest.llmsAssets.map((asset) =>
      asset.scope === "site"
        ? `${asset.scope}:${asset.surface}`
        : `${asset.scope}:${asset.section}`,
    ),
    ["section:api", "section:blog", "section:guide", "site:full", "site:index"],
  );

  const index = await readLlmsEndpointPayload(projectRoot, {
    scope: "site",
    surface: "index",
  });
  assert.match(
    index.body,
    /\[Leaf\]\(https:\/\/example\.test\/docs\/leaf\/index\.md\)/,
  );
  assert.match(
    index.body,
    /\[Guide\]\(https:\/\/example\.test\/docs\/guide\/llms\.txt\)/,
  );
  assert.match(
    index.body,
    /\[API\]\(https:\/\/example\.test\/docs\/api\/llms\.txt\)/,
  );
  assert.doesNotMatch(index.body, /v1|Hidden/);
  assert.match(index.body, /^# Test\n\n> Test docs\n\n/);

  const guide = await readLlmsEndpointPayload(projectRoot, {
    scope: "section",
    surface: "index",
    section: "guide",
  });
  // Sections are named for their index page, or their folder as the sidebar names it.
  assert.match(guide.body, /^# Guide\n/);
  assert.match(guide.body, /Guide A/);
  assert.match(guide.body, /Guide B.*Second guide/);
  assert.doesNotMatch(guide.body, /Hidden/);

  const full = await readLlmsEndpointPayload(projectRoot, {
    scope: "site",
    surface: "full",
  });
  assert.match(full.body, /# Guide A/);
  assert.match(full.body, /\*\*Guide B\*\*/);
  assert.match(full.body, /# API[\s\S]*API reference/);
  assert.match(full.body, /\[Users\]\(https:\/\/example\.test\/docs\/api\/tags\/users\)/);
  assert.match(full.body, /# Post/);
  assert.doesNotMatch(full.body, /# Old|# Hidden|Secret API/);

  assert.ok(
    manifest.markdownAssets.some(
      (asset) => asset.collection === "docs" && asset.id === "hidden",
    ),
  );
  assert.ok(
    manifest.markdownAssets.every((asset) => asset.collection !== "docs-v1"),
  );
});

test("without an llms-full.txt route, the document is neither built nor linked", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "guide", body: "Guide body", data: { title: "Guide" } },
  ]);
  configure(projectRoot, {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
    fullDocument: false,
  });
  const manifest = await ensureAgentEndpointAssets(projectRoot);
  assert.ok(manifest.llmsAssets.every((asset) => asset.surface !== "full"));
  const index = await readLlmsEndpointPayload(projectRoot, {
    scope: "site",
    surface: "index",
  });
  assert.doesNotMatch(index.body, /llms-full/);
});

test("Markdown and llms.txt endpoints expose metadata and stage bodies as assets", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "guide", body: "Unique prepared body", data: { title: "Guide" } },
  ]);
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
  };
  configure(projectRoot, options);

  const plugin = agentEndpointAssetsRuntimePlugin(projectRoot);
  const id = plugin.resolveId("virtual:nimbus/agent-endpoint-assets");
  assert.ok(id);
  const source = await plugin.load.call(
    { environment: { name: "ssr" } },
    id,
  );
  assert.ok(source);
  assert.doesNotMatch(source, /Unique prepared body/);
  assert.match(source, /assets\//);
  assert.doesNotMatch(source, /headings/);
  assert.equal(isAgentEndpointAssetRequested(projectRoot), true);
  const server = agentEndpointAssetsRuntimePlugin(projectRoot, () => true);
  assert.match(
    (await server.load.call({ environment: { name: "ssr" } }, id)) ?? "",
    /export const manifest = null;/,
  );
  assert.match(
    (await server.load.call({ environment: { name: "prerender" } }, id)) ?? "",
    /assets\//,
  );

  const output = path.join(projectRoot, "dist", "client");
  const stale = path.join(
    output,
    "_nimbus",
    "agent-endpoint-assets",
    "assets",
    "stale.txt",
  );
  await mkdir(path.dirname(stale), { recursive: true });
  await writeFile(stale, "stale");
  const legacyStale = path.join(
    output,
    "_nimbus",
    "prepared-artifacts",
    "assets",
    "stale.txt",
  );
  await mkdir(path.dirname(legacyStale), { recursive: true });
  await writeFile(legacyStale, "legacy stale");
  await stageAgentEndpointAssets(projectRoot, output);
  await assert.rejects(readFile(stale, "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(legacyStale, "utf8"), { code: "ENOENT" });
  const manifest = await ensureAgentEndpointAssets(projectRoot);
  const { headings: _headings, ...staged } = manifest;
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(output, "_nimbus", "agent-endpoint-assets", "manifest.json"),
        "utf8",
      ),
    ),
    JSON.parse(JSON.stringify(staged)),
  );
  for (const asset of [
    ...manifest.markdownAssets,
    ...manifest.llmsAssets,
  ]) {
    assert.equal(
      await readFile(
        path.join(output, "_nimbus", "agent-endpoint-assets", asset.path),
        "utf8",
      ),
      await readFile(
        path.join(
          projectRoot,
          ".astro",
          "nimbus",
          "agent-endpoint-assets",
          asset.path,
        ),
        "utf8",
      ),
    );
  }
  await removeAgentEndpointAssets(output);
  await assert.rejects(
    readdir(path.join(output, "_nimbus", "agent-endpoint-assets")),
    { code: "ENOENT" },
  );
});

test("agent-endpoint asset loader uses the Cloudflare assets binding only on Cloudflare", async () => {
  const cloudflare = agentEndpointAssetLoaderPlugin(() => "@astrojs/cloudflare");
  const cloudflareId = cloudflare.resolveId(
    "virtual:nimbus/agent-endpoint-asset-loader",
  );
  assert.ok(cloudflareId);
  const cloudflareSource = await cloudflare.load.call(
    { environment: { name: "ssr" } },
    cloudflareId,
  );
  assert.match(cloudflareSource ?? "", /cloudflare:workers/);
  assert.match(cloudflareSource ?? "", /env\.ASSETS/);
  const prerenderSource = await cloudflare.load.call(
    { environment: { name: "prerender" } },
    cloudflareId,
  );
  assert.doesNotMatch(prerenderSource ?? "", /cloudflare:workers|ASSETS/);

  const node = agentEndpointAssetLoaderPlugin(() => "@astrojs/node");
  const nodeId = node.resolveId("virtual:nimbus/agent-endpoint-asset-loader");
  assert.ok(nodeId);
  const nodeSource = await node.load(nodeId);
  assert.doesNotMatch(nodeSource ?? "", /cloudflare:workers|ASSETS/);
});

test("staging rejects manifest paths outside asset roots before cleanup", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "guide", body: "Guide", data: { title: "Guide" } },
  ]);
  configure(projectRoot, {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
  });
  const manifest = await ensureAgentEndpointAssets(projectRoot);
  const asset = manifest.markdownAssets[0];
  assert.ok(asset);
  asset.path = "../outside.md";

  const output = path.join(projectRoot, "dist", "client");
  const staged = path.join(
    output,
    "_nimbus",
    "agent-endpoint-assets",
    "assets",
    "retained.md",
  );
  const outsideTarget = path.join(output, "_nimbus", "outside.md");
  const outsideSource = path.join(
    projectRoot,
    ".astro",
    "nimbus",
    "outside.md",
  );
  await mkdir(path.dirname(staged), { recursive: true });
  await writeFile(staged, "retained");
  await writeFile(outsideTarget, "outside retained");
  await writeFile(outsideSource, "poisoned");

  await assert.rejects(
    stageAgentEndpointAssets(projectRoot, output),
    /asset path escapes its root/,
  );
  assert.equal(await readFile(staged, "utf8"), "retained");
  assert.equal(await readFile(outsideTarget, "utf8"), "outside retained");
});

test("staged agent-endpoint asset cleanup rejects a symlinked output root", async () => {
  const projectRoot = await root();
  const realOutput = path.join(projectRoot, "real-output");
  const linkedOutput = path.join(projectRoot, "linked-output");
  const retained = path.join(
    realOutput,
    "_nimbus",
    "agent-endpoint-assets",
    "retained.txt",
  );
  await mkdir(path.dirname(retained), { recursive: true });
  await writeFile(retained, "retained");
  await symlink(realOutput, linkedOutput, "dir");

  await assert.rejects(
    removeAgentEndpointAssets(linkedOutput),
    /contains a symbolic link/,
  );
  assert.equal(await readFile(retained, "utf8"), "retained");
});

test("waits for API index transactions before caching llms.txt output", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "guide", body: "Guide", data: { title: "Guide" } },
  ]);
  let apiEntries = [apiPage("Old API")];
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
  };
  let firstRead = true;
  let update: Promise<void> | undefined;
  configureAgentEndpointAssetRoot(projectRoot, "dev", () => {
    return bakeAgentEndpointAssets({
      ...options,
      loadApiEntries: async () => {
        const captured = apiEntries;
        if (firstRead) {
          firstRead = false;
          update = runPreparedMarkdownTransaction(
            preparedMarkdownRootKey(projectRoot),
            "api:api",
            async () => {
              apiEntries = [apiPage("New API")];
              markPreparedMarkdownRevision(projectRoot);
            },
          );
        }
        return captured;
      },
    });
  });

  await ensureAgentEndpointAssets(projectRoot);
  await update;
  const full = await readLlmsEndpointPayload(projectRoot, {
    scope: "site",
    surface: "full",
  });
  assert.match(full.body, /New API/);
  assert.doesNotMatch(full.body, /Old API/);
});

test("rebakes when invalidated during API input loading", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "guide", body: "Guide", data: { title: "Guide" } },
  ]);
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
  };
  let bakes = 0;
  let reads = 0;
  configureAgentEndpointAssetRoot(projectRoot, "dev", () => {
    bakes += 1;
    return bakeAgentEndpointAssets({
      ...options,
      loadApiEntries: async () => {
        reads += 1;
        if (reads === 1) invalidateAgentEndpointAssets(projectRoot);
        return [apiPage(reads === 1 ? "Old API" : "New API")];
      },
    });
  });

  const manifest = await ensureAgentEndpointAssets(projectRoot);
  assert.equal(bakes, 2);
  assert.deepEqual(
    (
      await readdir(path.join(projectRoot, ".astro/nimbus/agent-endpoint-assets/assets"))
    ).sort(),
    [...manifest.markdownAssets, ...manifest.llmsAssets]
      .map((asset) => path.basename(asset.path))
      .sort(),
  );
});

test("rejects page collisions and unsafe section route parameters", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "guide/page", body: "Page", data: { title: "Page" } },
    {
      id: "guide/llms.txt",
      body: "Reserved",
      data: { title: "Reserved", noindex: true },
    },
  ]);
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
  };
  await assert.rejects(
    bakeAgentEndpointAssets(options),
    /guide\/llms\.txt.*collides with the generated llms.txt route/s,
  );

  commit(projectRoot, "docs", [
    { id: "guide", body: "Guide", data: { title: "Guide" } },
    { id: "guide/index", body: "Index", data: { title: "Index" } },
  ]);
  await assert.rejects(
    bakeAgentEndpointAssets(options),
    /guide\/index.*collides with.*docs:guide.*generated Markdown route/s,
  );

  commit(projectRoot, "docs", [
    { id: "../secret", body: "Secret", data: { title: "Secret" } },
  ]);
  await assert.rejects(bakeAgentEndpointAssets(options), /section slug is unsafe/);

  commit(projectRoot, "docs", [
    {
      id: "guide/%252e%252e/secret",
      body: "Secret",
      data: { title: "Secret" },
    },
  ]);
  await assert.rejects(bakeAgentEndpointAssets(options), /unsafe entry ID/);

  commit(projectRoot, "docs", [
    { id: "%67uide/a", body: "A", data: { title: "A" } },
    { id: "%67uide/b", body: "B", data: { title: "B" } },
    {
      id: "guide/llms.txt",
      body: "Reserved",
      data: { title: "Reserved", noindex: true },
    },
  ]);
  await assert.rejects(
    bakeAgentEndpointAssets(options),
    /guide\/llms\.txt.*collides with the generated llms.txt route/s,
  );
});

test("a page under another collection's moved URL fails with the ownership error, not a route collision", async () => {
  const projectRoot = await root();
  const routes = new Map([["sdk", { mount: "/products/sdk", file: "src/pages/products/sdk/[...slug].astro", aliases: [] }]]);
  const urls = collectionUrlsKey({ versions: null, routes });
  commit(projectRoot, "docs", [
    { id: "index", body: "Home", data: { title: "Home" } },
    { id: "products/sdk/stray", body: "Stray", filePath: "src/content/docs/products/sdk/stray.mdx", data: { title: "Stray" } },
  ], urls);
  commit(projectRoot, "sdk", [
    { id: "index", body: "SDK", data: { title: "SDK" } },
    { id: "install", body: "Install", data: { title: "Install" } },
  ], urls);
  await assert.rejects(
    bakeAgentEndpointAssets({ root: projectRoot, base: "/docs", site: "https://example.test", title: "Test", routes }),
    /docs page src\/content\/docs\/products\/sdk\/stray\.mdx is at \/products\/sdk\/stray, under \/products\/sdk, where collection "sdk" is served/,
  );
});

test("uses locale-independent ordering in llms.txt indexes", async () => {
  const projectRoot = await root();
  const ids = ["zulu", "Alpha", "äther"];
  commit(
    projectRoot,
    "docs",
    ids.map((id) => ({ id, body: id, data: { title: id } })),
  );
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
  };
  configure(projectRoot, options);
  await bakeAgentEndpointAssets(options);
  const index = await readLlmsEndpointPayload(projectRoot, {
    scope: "site",
    surface: "index",
  });
  const titles = index.body
    .split("\n")
    .filter((line) => line.startsWith("- ["))
    .map((line) => line.slice(3, line.indexOf("]")));
  assert.deepEqual(titles, ["Alpha", "zulu", "äther"]);
});

test("preserves protocol-relative social images", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "guide", body: "Guide", data: { title: "Guide" } },
  ]);
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
    socialImage: "//cdn.example.test/og.png",
  };
  configure(projectRoot, options);
  await bakeAgentEndpointAssets(options);
  const markdown = await readMarkdownEndpointPayload(projectRoot, {
    collection: "docs",
    id: "guide",
    surface: "markdown",
  });
  assert.match(markdown.body, /image: "https:\/\/cdn\.example\.test\/og\.png"/);
});

test("resolves the complete audience before touching partials", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    {
      id: "excluded",
      body: '<Render file="missing" />',
      data: { title: "Excluded", draft: true },
    },
    { id: "public", body: "Public", data: { title: "Public" } },
  ]);

  const manifest = await bakeAgentEndpointAssets({
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
  });
  assert.deepEqual(
    manifest.markdownAssets.map(({ id, surface }) => [id, surface]),
    [
      ["public", "markdown"],
      ["public", "source"],
    ],
  );
});

test("fails closed for unknown audiences and invalid transitive partials", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    {
      id: "guide",
      body: '<Render file="hidden" />',
      data: { title: "Guide" },
    },
  ]);
  commit(projectRoot, "partials", [
    { id: "hidden", body: "Secret", data: { draft: true } },
  ]);
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
  };
  await assert.rejects(
    bakeAgentEndpointAssets(options),
    /exclude.*partials:hidden|excluded partial/s,
  );

  commit(projectRoot, "docs", [
    {
      id: "guide",
      body: "Guide",
      data: { title: "Guide", visibility: "request" },
    },
  ]);
  await assert.rejects(
    bakeAgentEndpointAssets(options),
    /visibility is unknown.*docs:guide/s,
  );
});

test("rejects stale collection capabilities", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "guide", body: "Guide", data: { title: "Guide" } },
  ]);
  const key = preparedMarkdownRootKey(projectRoot);
  const epoch = beginPreparedMarkdownLoad(key, "docs", false);
  commitPreparedMarkdownCollection(
    key,
    "docs",
    epoch,
    { generation: AGENT_ENDPOINT_ASSET_GENERATION, base: "/wrong" },
    [{ id: "guide", body: "Guide", data: { title: "Guide" } }] as never,
  );
  await assert.rejects(
    bakeAgentEndpointAssets({
      root: projectRoot,
      base: "/docs",
      site: "https://example.test",
      title: "Test",
    }),
    /collection "docs".*not prepared/s,
  );
});

test("prepares headings without requiring every indexed collection to support prepared Markdown", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    {
      id: "guide",
      body: "## Guide",
      data: { title: "Guide" },
      headings: [{ depth: 2, text: "Guide", slug: "guide" }],
    },
  ]);
  commit(projectRoot, "bodyless", [
    {
      id: "rendered",
      data: { title: "Rendered" },
      headings: [{ depth: 2, text: "Rendered", slug: "rendered" }],
    },
  ]);

  const records = await bakePreparedHeadings({
    root: projectRoot,
    base: "/docs",
  });
  assert.deepEqual(
    records.map(({ collection, id }) => `${collection}:${id}`),
    ["docs:guide"],
  );

  let assetBakes = 0;
  configureAgentEndpointAssetRoot(
    projectRoot,
    "build",
    async () => {
      assetBakes += 1;
      throw new Error("strict asset bake should not run");
    },
    () =>
      bakePreparedHeadings({
        root: projectRoot,
        base: "/docs",
      }),
    "/docs",
  );
  const plugin = preparedHeadingsPlugin(projectRoot);
  const resolved = plugin.resolveId("virtual:nimbus/headings")!;
  const source = await plugin.load(resolved);
  assert.equal(assetBakes, 0);
  assert.match(source ?? "", /export const base = "\/docs"/u);
  assert.match(source ?? "", /"collection":"docs","id":"guide"/u);
  assert.doesNotMatch(source ?? "", /bodyless|unwrapped/u);
  const headingModule = {};
  let invalidated: unknown;
  plugin.handleHotUpdate({
    server: {
      moduleGraph: {
        getModuleById: () => headingModule,
        invalidateModule: (module) => {
          invalidated = module;
        },
      },
    },
  });
  assert.equal(invalidated, headingModule);
});

test("joins concurrent rebakes and rejects symlinked agent-endpoint asset roots", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "guide", body: "Guide", data: { title: "Guide" } },
  ]);
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
  };
  let calls = 0;
  configureAgentEndpointAssetRoot(projectRoot, "dev", async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return bakeAgentEndpointAssets(options);
  });
  const [first, second] = await Promise.all([
    ensureAgentEndpointAssets(projectRoot),
    ensureAgentEndpointAssets(projectRoot),
  ]);
  assert.deepEqual(second, first);
  assert.equal(calls, 1);

  const escapedRoot = await root();
  commit(escapedRoot, "docs", [
    { id: "guide", body: "Guide", data: { title: "Guide" } },
  ]);
  const outside = await root();
  await mkdir(path.join(escapedRoot, ".astro/nimbus"), { recursive: true });
  await symlink(outside, path.join(escapedRoot, ".astro/nimbus/agent-endpoint-assets"), "dir");
  await assert.rejects(
    bakeAgentEndpointAssets({ ...options, root: escapedRoot }),
    /symbolic link/,
  );
});

test("queues a follow-up bake when invalidated during in-flight work", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "guide", body: "Guide", data: { title: "Guide" } },
  ]);
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
  };
  let calls = 0;
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  configureAgentEndpointAssetRoot(projectRoot, "dev", async () => {
    calls += 1;
    const manifest = await bakeAgentEndpointAssets(options);
    if (calls === 1) {
      entered?.();
      await gate;
    }
    return manifest;
  });

  const read = ensureAgentEndpointAssets(projectRoot);
  await started;
  invalidateAgentEndpointAssets(projectRoot);
  release?.();
  await read;
  assert.equal(calls, 2);
});

function countingSite(projectRoot: string, mode: "build" | "dev") {
  const counter = { renders: 0 };
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
    componentMap: {
      Count: {
        revision: "v1",
        render: () => {
          counter.renders += 1;
          return "counted";
        },
      },
    },
  };
  configureAgentEndpointAssetRoot(projectRoot, mode, () => bakeAgentEndpointAssets(options));
  const rebake = () => {
    invalidateAgentEndpointAssets(projectRoot);
    return ensureAgentEndpointAssets(projectRoot);
  };
  return { counter, options, rebake };
}

const countedPages = (bodyOfB = "B") => [
  { id: "a", body: '<Count />\n\n<Render file="note" />', data: { title: "A" } },
  { id: "b", body: `<Count />\n\n${bodyOfB}`, data: { title: "B" } },
  { id: "c", body: "<Count />\n\nC", data: { title: "C" } },
];

test("dev reuses an unchanged page's Markdown, byte-identical to a build", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", countedPages());
  commit(projectRoot, "partials", [{ id: "note", body: "Note.", data: {} }]);
  const { counter, options, rebake } = countingSite(projectRoot, "dev");
  await ensureAgentEndpointAssets(projectRoot);
  await rebake();
  assert.equal(counter.renders, 3);

  commit(projectRoot, "docs", countedPages("B, edited"));
  const edited = await rebake();
  assert.equal(counter.renders, 4);
  configureAgentEndpointAssetRoot(projectRoot, "build", () => bakeAgentEndpointAssets(options));
  assert.deepEqual(await bakeAgentEndpointAssets(options), edited);
});

test("dev renders every page again when a partial or a component revision changes", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", countedPages());
  commit(projectRoot, "partials", [{ id: "note", body: "Note.", filePath: "note.mdx", data: {} }]);
  const { counter, options, rebake } = countingSite(projectRoot, "dev");
  const renders = async () => {
    const before = counter.renders;
    await rebake();
    return counter.renders - before;
  };
  await ensureAgentEndpointAssets(projectRoot);

  commit(projectRoot, "partials", [{ id: "note", body: "Note, edited.", filePath: "note.mdx", data: {} }]);
  assert.equal(await renders(), 3);
  commit(projectRoot, "partials", [{ id: "note", body: "Note, edited.", filePath: "note.md", data: {} }]);
  assert.equal(await renders(), 3);
  options.componentMap.Count.revision = "v2";
  assert.equal(await renders(), 3);
  assert.equal(await renders(), 0);
});

test("dev still rejects a page whose partial stopped being public", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", countedPages());
  commit(projectRoot, "partials", [{ id: "note", body: "Note.", data: {} }]);
  const { rebake } = countingSite(projectRoot, "dev");
  await ensureAgentEndpointAssets(projectRoot);
  commit(projectRoot, "partials", [{ id: "note", body: "Note.", data: { draft: true } }]);
  await assert.rejects(rebake(), /partial "partials:note"/);
});

test("a build renders every page on every bake", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", countedPages());
  commit(projectRoot, "partials", [{ id: "note", body: "Note.", data: {} }]);
  const { counter, options } = countingSite(projectRoot, "build");
  await bakeAgentEndpointAssets(options);
  await bakeAgentEndpointAssets(options);
  assert.equal(counter.renders, 6);
});

test("dev doesn't re-read files it published, and rewrites one that went missing", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", countedPages());
  commit(projectRoot, "partials", [{ id: "note", body: "Note.", data: {} }]);
  const { rebake } = countingSite(projectRoot, "dev");
  const manifest = await ensureAgentEndpointAssets(projectRoot);
  const directory = path.join(projectRoot, ".astro/nimbus/agent-endpoint-assets");
  const [kept, removed] = manifest.markdownAssets.map((asset) => path.join(directory, asset.path));
  const body = await readFile(removed!, "utf8");
  const tampered = "x".repeat(Buffer.byteLength(await readFile(kept!, "utf8")));
  await writeFile(kept!, tampered);
  await rm(removed!);

  await rebake();
  assert.equal(await readFile(kept!, "utf8"), tampered);
  assert.equal(await readFile(removed!, "utf8"), body);
});

test("a build still reads back every file it would keep", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", countedPages());
  commit(projectRoot, "partials", [{ id: "note", body: "Note.", data: {} }]);
  const { rebake } = countingSite(projectRoot, "build");
  const manifest = await ensureAgentEndpointAssets(projectRoot);
  const kept = path.join(projectRoot, ".astro/nimbus/agent-endpoint-assets", manifest.markdownAssets[0]!.path);
  await writeFile(kept, "x".repeat(Buffer.byteLength(await readFile(kept, "utf8"))));
  await assert.rejects(rebake(), /asset collision/);
});

test("removes assets made obsolete by edits and deletions", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "guide", body: "Old guide", data: { title: "Guide" } },
    { id: "removed", body: "Removed", data: { title: "Removed" } },
  ]);
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
  };
  configure(projectRoot, options);
  await bakeAgentEndpointAssets(options);

  configure(projectRoot, options);

  commit(projectRoot, "docs", [
    { id: "guide", body: "New guide", data: { title: "Guide" } },
  ]);
  const manifest = await bakeAgentEndpointAssets(options);
  const files = await readdir(
    path.join(projectRoot, ".astro/nimbus/agent-endpoint-assets/assets"),
  );
  assert.deepEqual(
    files.sort(),
    [...manifest.markdownAssets, ...manifest.llmsAssets]
      .map((asset) => path.basename(asset.path))
      .sort(),
  );
});

test("scopes agent-endpoint asset demand to the current configuration session", async () => {
  const projectRoot = await root();
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
  };
  configure(projectRoot, options);
  registerAgentEndpointAssetDemand(projectRoot);
  assert.equal(isAgentEndpointAssetRequested(projectRoot), true);

  configure(projectRoot, options);
  assert.equal(isAgentEndpointAssetRequested(projectRoot), false);
});

test("bakes every Markdown asset at its public URL, API pages included, hidden API versions excluded", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "index", body: "Home", data: { title: "Home" } },
    { id: "guide/index", body: "Guide", data: { title: "Guide" } },
  ]);
  commit(projectRoot, "docs-v1", [
    { id: "old", body: "Old", data: { title: "Old" } },
  ]);
  const visible = apiPage("SmallCo API");
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
    socialImage: "/og.png",
    versions: { current: "v2", others: ["v1"] },
    apiEntries: [
      { ...visible, hidden: false },
      {
        ...apiPage("Unlisted"),
        id: "unlisted",
        hidden: false,
        data: { ...apiPage("Unlisted").data, coordinate: "unlisted", noindex: true },
      },
      {
        ...apiPage("Old API"),
        id: "v0",
        hidden: true,
        data: { ...apiPage("Old API").data, coordinate: "v0", version: "v0" },
      },
    ],
  };
  configure(projectRoot, options);
  const manifest = await bakeAgentEndpointAssets(options);

  assert.equal(manifest.version, 6);
  assert.deepEqual(
    manifest.markdownAssets.map((asset) => `${asset.surface} ${asset.url}`).sort(),
    [
      "markdown /api/index.md",
      "markdown /api/unlisted/index.md",
      "markdown /guide/index.md",
      "markdown /index.md",
      "markdown /v1/old/index.md",
      "source /guide/index.mdx",
      "source /index.mdx",
      "source /v1/old/index.mdx",
    ],
  );

  const api = await readMarkdownEndpointPayload(projectRoot, {
    collection: "api",
    id: "index",
    surface: "markdown",
  });
  assert.equal(
    api.body,
    [
      "---",
      'title: "SmallCo API"',
      'image: "https://example.test/docs/og.png"',
      "---",
      "",
      "> Documentation Index",
      "> Fetch the complete documentation index at: https://example.test/docs/llms.txt",
      "> Use this file to discover all available pages before exploring further.",
      "",
      "# SmallCo API",
      "",
      api.content,
      "",
      "Source: https://example.test/docs/api/index.md",
      "",
    ].join("\n"),
  );
  assert.doesNotMatch(api.content, /^# /);
  assert.equal(
    api.content,
    renderApiPageMarkdown(visible.data.prepared.page as never, { base: "/docs" }),
  );
});

test("bakes the MCP page index only for a site that serves /mcp; API pages carry no docs version", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "guide", body: "Guide", data: { title: "Guide" } },
    { id: "hidden", body: "Hidden", data: { title: "Hidden", noindex: true } },
  ]);
  commit(projectRoot, "docs-v1", [{ id: "old", body: "Old", data: { title: "Old" } }]);
  const base = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
    versions: { current: "v2", others: ["v1"], deprecated: ["v1"] },
    apiEntries: [
      {
        ...apiPage("Pets API"),
        hidden: false,
        data: { ...apiPage("Pets API").data, version: "v1" },
      },
    ],
  };
  configure(projectRoot, base);
  assert.equal((await bakeAgentEndpointAssets(base)).pageIndex, undefined);

  const options = { ...base, mcpUrl: "https://example.test/docs/mcp" };
  configure(projectRoot, options);
  const manifest = await bakeAgentEndpointAssets(options);
  assert.ok(manifest.pageIndex);
  const index = JSON.parse(
    await readFile(path.join(projectRoot, ".astro/nimbus/agent-endpoint-assets", manifest.pageIndex.path), "utf8"),
  );
  assert.deepEqual(index.versions, ["v2", "v1"]);
  assert.deepEqual(
    index.pages.map((page: { url: string; section: string; version?: string; deprecated?: true; searchable: boolean }) => [
      page.url,
      page.section,
      page.version ?? null,
      page.deprecated ?? false,
      page.searchable,
    ]),
    [
      ["https://example.test/docs/api/", "api", null, false, true],
      ["https://example.test/docs/guide/", "guide", "v2", false, true],
      ["https://example.test/docs/hidden/", "hidden", "v2", false, false],
      ["https://example.test/docs/v1/old/", "v1", "v1", true, true],
    ],
  );
});

test("fails when a docs page and an API page share a public Markdown path", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "api", body: "A docs page at /api", data: { title: "Docs API" } },
  ]);
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
    apiEntries: [{ ...apiPage("SmallCo API"), hidden: false }],
  };
  configure(projectRoot, options);
  await assert.rejects(
    bakeAgentEndpointAssets(options),
    /page "api:index" collides with page "docs:api" at generated Markdown route "\/api"/,
  );
});

test("nested sections: each folder lists its own pages and links its sub-sections", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "intro", body: "Intro", data: { title: "Intro" } },
    { id: "reference", body: "Ref home", data: { title: "Reference" } },
    { id: "reference/overview", body: "Overview", data: { title: "Overview" } },
    {
      id: "reference/functions",
      body: "Functions home",
      data: { title: "Functions home", sidebar: { group: { label: "Functions" } } },
    },
    { id: "reference/functions/math", body: "Math", data: { title: "Math functions" } },
    { id: "reference/functions/dates/parse", body: "Parse", data: { title: "Parse dates" } },
    { id: "reference/functions/dates/format", body: "Format", data: { title: "Format dates" } },
    { id: "reference/settings/a", body: "A", data: { title: "Setting A" } },
  ]);
  commit(projectRoot, "blog", [
    { id: "index", body: "Blog", data: { title: "Blog" } },
    { id: "2024/launch", body: "Launch", data: { title: "Launch" } },
  ]);
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
    nestedSections: true,
  };
  configure(projectRoot, options);
  const manifest = await bakeAgentEndpointAssets(options);
  assert.deepEqual(
    manifest.llmsAssets.filter((asset) => asset.scope === "section").map((asset) => asset.section).sort(),
    [
      "blog",
      "blog/2024",
      "reference",
      "reference/functions",
      "reference/functions/dates",
      "reference/settings",
    ],
  );
  const section = async (name: string) =>
    (await readLlmsEndpointPayload(projectRoot, { scope: "section", surface: "index", section: name })).body;

  assert.equal(
    await section("reference"),
    [
      "# Reference",
      "",
      "## Pages",
      "",
      "- [Reference](https://example.test/docs/reference/index.md)",
      "- [Overview](https://example.test/docs/reference/overview/index.md)",
      "",
      "## Sections",
      "",
      "- [Functions](https://example.test/docs/reference/functions/llms.txt)",
      "- [Settings](https://example.test/docs/reference/settings/llms.txt)",
      "",
    ].join("\n"),
  );
  assert.equal(
    await section("reference/functions"),
    [
      "# Functions",
      "",
      "## Pages",
      "",
      "- [Functions home](https://example.test/docs/reference/functions/index.md)",
      "- [Math functions](https://example.test/docs/reference/functions/math/index.md)",
      "",
      "## Sections",
      "",
      "- [Dates](https://example.test/docs/reference/functions/dates/llms.txt)",
      "",
    ].join("\n"),
  );
  // A section with only sub-folders has no empty "Pages" list; the deepest lists only pages.
  assert.doesNotMatch(await section("reference/functions/dates"), /## Sections/);
  assert.match(await section("reference/functions/dates"), /Format dates[\s\S]*Parse dates/);
  assert.match(await section("blog"), /\[Blog\][\s\S]*## Sections\n\n- \[2024\]\(https:\/\/example\.test\/docs\/blog\/2024\/llms\.txt\)/);

  // The site index is unchanged by nesting: top-level pages and sections only.
  const site = (await readLlmsEndpointPayload(projectRoot, { scope: "site", surface: "index" })).body;
  assert.match(site, /\[Reference\]\(https:\/\/example\.test\/docs\/reference\/llms\.txt\)/);
  assert.doesNotMatch(site, /functions\/llms\.txt/);
});

test("nested sections leave a site without sub-folders byte-identical", async () => {
  const bake = async (nestedSections: boolean) => {
    const projectRoot = await root();
    commit(projectRoot, "docs", [
      { id: "leaf", body: "Leaf", data: { title: "Leaf" } },
      { id: "guide", body: "Guide", data: { title: "Guide" } },
      { id: "guide/a", body: "A", data: { title: "A", description: "First" } },
      { id: "guide/b", body: "B", data: { title: "B" } },
    ]);
    commit(projectRoot, "blog", [{ id: "post", body: "Post", data: { title: "Post" } }]);
    const options = { root: projectRoot, base: "/docs", site: "https://example.test", title: "Test", nestedSections };
    configure(projectRoot, options);
    const manifest = await bakeAgentEndpointAssets(options);
    return Promise.all(
      manifest.llmsAssets.map(async (asset) => [
        asset.scope === "section" ? asset.section : asset.surface,
        (await readLlmsEndpointPayload(projectRoot, asset)).body,
      ]),
    );
  };
  assert.deepEqual(await bake(true), await bake(false));
});

test("nested sections: a collection in another slice is linked from the section above it", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "reference/overview", body: "Overview", data: { title: "Overview" } },
    { id: "guide", body: "Guide", data: { title: "Guide" } },
  ]);
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
    nestedSections: true,
    absentSections: [
      { slug: "reference/sdk", label: "SDK" },
      { slug: "cli", label: "CLI" },
    ],
  };
  configure(projectRoot, options);
  await bakeAgentEndpointAssets(options);
  const body = (await readLlmsEndpointPayload(projectRoot, { scope: "section", surface: "index", section: "reference" })).body;
  assert.match(body, /## Sections\n\n- \[SDK\]\(https:\/\/example\.test\/docs\/reference\/sdk\/llms\.txt\)\n$/);
  assert.doesNotMatch(body, /cli/);
});

test("nested sections: collection links follow the sidebar with the section's other sub-sections", async () => {
  const projectRoot = await root();
  const routes = new Map([
    ["sdk", { mount: "/reference/sdk", file: "src/pages/reference/sdk/[...slug].astro", aliases: [] }],
    ["cli", { mount: "/reference/cli", file: "src/pages/reference/cli/[...slug].astro", aliases: [] }],
  ]);
  const urls = collectionUrlsKey({ versions: null, routes });
  commit(projectRoot, "docs", [
    { id: "reference", body: "Reference", data: { title: "Reference" } },
    { id: "reference/basics/a", body: "A", data: { title: "A" } },
    { id: "reference/basics/b", body: "B", data: { title: "B" } },
  ], urls);
  commit(projectRoot, "sdk", [{ id: "start", body: "SDK", data: { title: "SDK start" } }], urls);
  commit(projectRoot, "cli", [{ id: "start", body: "CLI", data: { title: "CLI start" } }], urls);
  // The sidebar reads Reference, then SDK, CLI, Basics.
  const order = ["/reference", "/reference/sdk/start", "/reference/cli/start", "/reference/basics/a", "/reference/basics/b"];
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
    nestedSections: true,
    routes,
    sidebarPosition: async () => (page: { url: string }) => {
      const index = order.indexOf(page.url.replace(/\/$/, ""));
      return index === -1 ? undefined : index;
    },
  };
  configure(projectRoot, options);
  await bakeAgentEndpointAssets(options);
  const body = (await readLlmsEndpointPayload(projectRoot, { scope: "section", surface: "index", section: "reference" })).body;
  const sections = [...body.matchAll(/\/(reference\/[a-z]+)\/llms\.txt/g)].map((match) => match[1]);
  assert.deepEqual(sections, ["reference/sdk", "reference/cli", "reference/basics"]);
});

test("a section another slice builds is listed where the sidebar links it", async () => {
  const { llmsSidebarPosition } = await import("../src/_internal/llms-order.ts");
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "guide", body: "Guide", data: { title: "Guide" } },
    { id: "zeta", body: "Zeta", data: { title: "Zeta" } },
  ]);
  const link = (label: string, href: string) => ({ type: "link" as const, label, href, order: 0 });
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
    absentSections: [{ slug: "api", label: "API" }],
    // The sidebar reads Zeta, API, Guide.
    sidebarPosition: async () =>
      llmsSidebarPosition({
        tree: [link("Zeta", "/zeta/"), link("API", "/api/"), link("Guide", "/guide/")],
        apiMounts: new Map(),
        apiNavOrder: () => undefined,
      }),
  };
  configure(projectRoot, options);
  await bakeAgentEndpointAssets(options);
  const body = (await readLlmsEndpointPayload(projectRoot, { scope: "site", surface: "index" })).body;
  const rows = [...body.matchAll(/^- \[([^\]]+)\]/gm)].map((match) => match[1]);
  assert.deepEqual(rows, ["Zeta", "API", "Guide"]);
});

test("without nested sections, a top-level section lists every page under it", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "reference/overview", body: "Overview", data: { title: "Overview" } },
    { id: "reference/functions/math", body: "Math", data: { title: "Math" } },
  ]);
  const options = { root: projectRoot, base: "/docs", site: "https://example.test", title: "Test" };
  configure(projectRoot, options);
  const manifest = await bakeAgentEndpointAssets(options);
  assert.deepEqual(
    manifest.llmsAssets.filter((asset) => asset.scope === "section").map((asset) => asset.section),
    ["reference"],
  );
  const body = (await readLlmsEndpointPayload(projectRoot, { scope: "section", surface: "index", section: "reference" })).body;
  assert.match(body, /Math[\s\S]*Overview|Overview[\s\S]*Math/);
  assert.doesNotMatch(body, /## Sections/);
});

test("llms-full.txt over the limit splits by section, recursing where a section is still too big", async () => {
  const projectRoot = await root();
  const big = (label: string) => `${label} `.repeat(300);
  commit(projectRoot, "docs", [
    { id: "welcome", body: "Welcome", data: { title: "Welcome" } },
    { id: "concepts/a", body: big("concepts"), data: { title: "Concept A" } },
    { id: "reference", body: "Reference home", data: { title: "Reference" } },
    { id: "reference/functions/math", body: big("math"), data: { title: "Math" } },
    { id: "reference/functions/dates", body: big("dates"), data: { title: "Dates" } },
    { id: "reference/settings/one", body: big("settings"), data: { title: "Setting one" } },
    { id: "huge/only", body: big("huge").repeat(4), data: { title: "Huge" } },
  ]);
  commit(projectRoot, "docs-v1", [{ id: "old", body: big("old"), data: { title: "Old" } }]);
  const warnings: string[] = [];
  const infos: string[] = [];
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
    llmsFullLimitBytes: 4000,
    versions: { current: "v2", others: ["v1"] },
    warn: (message: string) => warnings.push(message),
    info: (message: string) => infos.push(message),
  };
  configure(projectRoot, options);
  const manifest = await bakeAgentEndpointAssets(options);
  const full = manifest.llmsAssets.filter((asset) => asset.surface === "full");
  const bodies = new Map(
    await Promise.all(
      full.map(async (asset) => [
        asset.scope === "section" ? asset.section : "",
        (await readLlmsEndpointPayload(projectRoot, asset)).body,
      ] as const),
    ),
  );
  assert.deepEqual([...bodies.keys()].sort(), [
    "",
    "concepts",
    "huge",
    "reference",
    "reference/functions",
    "reference/settings",
  ]);

  const rootIndex = bodies.get("")!;
  assert.match(rootIndex, /^# Test\n\n> The full documentation is over 4 KiB, so it's split by section\./);
  assert.match(rootIndex, /Index: https:\/\/example\.test\/docs\/llms\.txt/);
  // Sizes only for files served whole; an index just says it's split.
  assert.match(rootIndex, /- \[Reference\]\(https:\/\/example\.test\/docs\/reference\/llms-full\.txt\) \(split further\)/);
  assert.match(rootIndex, /- \[Concepts\]\(https:\/\/example\.test\/docs\/concepts\/llms-full\.txt\) \(\d+ KiB\)/);
  assert.match(rootIndex, /## Pages\n\n- \[Welcome\]\(https:\/\/example\.test\/docs\/welcome\/index\.md\)/);
  // An over-limit section is an index of its sub-sections and links to its own pages.
  assert.match(bodies.get("reference")!, /## Sections[\s\S]*functions\/llms-full\.txt[\s\S]*settings\/llms-full\.txt[\s\S]*## Pages\n\n- \[Reference\]/);
  assert.match(bodies.get("reference/functions")!, /^# Test — Functions\n[\s\S]*# Dates[\s\S]*# Math/);

  // Every page appears in exactly one file, in full or as a link.
  const titles = ["Welcome", "Concept A", "Reference", "Math", "Dates", "Setting one", "Huge"];
  for (const title of titles) {
    const holders = [...bodies.values()].filter(
      (body) => body.includes(`\n# ${title}\n`) || new RegExp(`- \\[${title}\\]\\([^)]*/index\\.md\\)`).test(body),
    );
    assert.equal(holders.length, 1, title);
  }
  // Older docs versions stay out of the full document, as before the split.
  assert.ok([...bodies.values()].every((body) => !body.includes("Old")));
  // A folder over the limit with no sub-folders is a list of links, so no
  // llms-full.txt is over the limit.
  for (const [section, body] of bodies) {
    assert.ok(Buffer.byteLength(body) <= 4000, section);
  }
  assert.match(bodies.get("huge")!, /has no sub-folders, so it links to each page's Markdown[\s\S]*## Pages\n\n- \[Huge\]\(https:\/\/example\.test\/docs\/huge\/only\/index\.md\)/);
  assert.match(rootIndex, /- \[Huge\]\(https:\/\/example\.test\/docs\/huge\/llms-full\.txt\) \(links to its pages\)/);
  assert.match(infos[0]!, /split by section:[\s\S]*\/reference\/functions\/llms-full\.txt \d+ KiB/);
  assert.match(infos[0]!, /\/llms-full\.txt \d+ KiB \(index\)/);
  assert.match(infos[0]!, /\/huge\/llms-full\.txt \d+ KiB \(index; its pages total \d+ KiB with no sub-folders to split by\)/);
  // Only that page's own Markdown files are over the limit, and the build says so.
  assert.ok(warnings.length > 0);
  for (const warning of warnings) {
    assert.match(warning, /^\/huge\/only\/index\.mdx? is .* over Cloudflare's 25 MiB file limit, so the deploy will fail\.$/);
  }

  const site = (await readLlmsEndpointPayload(projectRoot, { scope: "site", surface: "index" })).body;
  assert.match(site, /Full documentation \(discoverable current pages, split by section\)/);
});

test("llms-full.txt under the limit is one document, sized exactly as written", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "a", body: "Café ☕ body", data: { title: "A", description: "First" } },
    { id: "b/c", body: "", data: { title: "C" } },
  ]);
  const options = { root: projectRoot, base: "/docs", site: "https://example.test", title: "Test", description: "Docs" };
  configure(projectRoot, options);
  const manifest = await bakeAgentEndpointAssets(options);
  assert.deepEqual(
    manifest.llmsAssets.filter((asset) => asset.surface === "full").map((asset) => asset.scope),
    ["site"],
  );
  const { buildLlmsFullMarkdown, llmsFullBlockBytes, llmsFullHeaderBytes } = await import("../src/_internal/llms-full.ts");
  const header = { title: "Test", description: "Docs", site: "https://example.test", base: "/docs" };
  const blocks = [
    { title: "A", description: "First", url: "/a/", markdownUrl: "/a/index.md", markdown: "Café ☕ body" },
    { title: "C", url: "/b/c/", markdownUrl: "/b/c/index.md", markdown: "" },
  ];
  assert.equal(
    llmsFullHeaderBytes(header) + blocks.reduce((sum, block) => sum + llmsFullBlockBytes(block, header), 0) - 1,
    Buffer.byteLength(buildLlmsFullMarkdown(blocks, header)),
  );
});

test("a split of top-level pages only still says llms-full.txt is split", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "a", body: "a ".repeat(500), data: { title: "A" } },
    { id: "b", body: "b ".repeat(500), data: { title: "B" } },
  ]);
  const options = { root: projectRoot, base: "/docs", site: "https://example.test", title: "Test", llmsFullLimitBytes: 1200 };
  configure(projectRoot, options);
  await bakeAgentEndpointAssets(options);
  const site = (await readLlmsEndpointPayload(projectRoot, { scope: "site", surface: "index" })).body;
  assert.match(site, /split by section/);
  const full = (await readLlmsEndpointPayload(projectRoot, { scope: "site", surface: "full" })).body;
  assert.match(full, /## Pages\n\n- \[A\][\s\S]*- \[B\]/);
});

test("an index listing too many entries warns that the deploy will fail", async () => {
  const projectRoot = await root();
  commit(
    projectRoot,
    "docs",
    Array.from({ length: 40 }, (_, i) => ({ id: `page-${i}`, body: "x ".repeat(40), data: { title: `Page ${i}` } })),
  );
  const warnings: string[] = [];
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
    llmsFullLimitBytes: 1500,
    warn: (message: string) => warnings.push(message),
  };
  configure(projectRoot, options);
  await bakeAgentEndpointAssets(options);
  assert.ok(warnings.some((warning) => /^\/llms-full\.txt is \d+ KiB, over Cloudflare's 25 MiB file limit, so the deploy will fail\.$/.test(warning)), warnings.join("\n"));
});

test("a manifest over the static file limit fails staging before any file is copied", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "guide", body: "Unique prepared body", data: { title: "Guide" } },
  ]);
  configure(projectRoot, {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
  });
  const output = path.join(projectRoot, "dist", "client");
  await assert.rejects(
    stageAgentEndpointAssets(projectRoot, output, 64),
    /manifest\.json is \d+ KiB, over Cloudflare's 25 MiB static file limit/,
  );
  await assert.rejects(readdir(path.join(output, "_nimbus")), { code: "ENOENT" });
});

/** Every heading CommonMark finds, outside code, as `depth text`. Markdown
 * versions and llms-full.txt are plain Markdown, so not parsed as MDX. */
function parsedHeadings(source: string): { headings: string[]; code: string[] } {
  const tree = fromMarkdown(source.replace(/^---\n[\s\S]*?\n---\n/, ""));
  const headings: string[] = [];
  const code: string[] = [];
  const text = (node: any): string =>
    typeof node.value === "string" ? node.value : (node.children ?? []).map(text).join("");
  const visit = (node: any): void => {
    if (node.type === "heading") headings.push(`${node.depth} ${text(node)}`);
    if (node.type === "code") code.push(node.value);
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return { headings, code };
}

test("spec text can't add a page heading to an API page's Markdown or llms-full.txt", async () => {
  const projectRoot = await root();
  commit(projectRoot, "docs", [
    { id: "guide", body: "Guide body", data: { title: "Guide", description: "About the guide" } },
  ]);
  const hostile = [
    "Intro.",
    "",
    "# Foo",
    "",
    "> # Quoted",
    "",
    "- # Listed",
    "",
    "> Setext",
    "> ===",
    "",
    "```sh",
    "# install",
    "```",
  ].join("\n");
  const page = apiPage("Title\n# Forged");
  const entry = {
    ...page,
    hidden: false,
    data: {
      ...page.data,
      description: "Starts a registration.",
      prepared: { ...page.data.prepared, page: { ...page.data.prepared.page, description: hostile } },
    },
  };
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
    apiEntries: [entry],
  };
  configure(projectRoot, options);
  const manifest = await bakeAgentEndpointAssets(options);

  const twin = await readMarkdownEndpointPayload(projectRoot, {
    collection: "api",
    id: "index",
    surface: "markdown",
  });
  assert.doesNotMatch(twin.body.split("\n---\n")[0]!, /^description:/m);
  const twinTree = parsedHeadings(twin.body);
  assert.deepEqual(twinTree.headings, ["1 Title # Forged", "3 Foo", "3 Quoted", "3 Listed"]);
  assert.deepEqual(twinTree.code, ["# install"]);

  const guide = await readMarkdownEndpointPayload(projectRoot, {
    collection: "docs",
    id: "guide",
    surface: "markdown",
  });
  assert.match(guide.body, /^description: "About the guide"$/m);

  const full = manifest.llmsAssets.find((asset) => asset.surface === "full")!;
  const body = (await readLlmsEndpointPayload(projectRoot, full)).body;
  const fullTree = parsedHeadings(body);
  assert.deepEqual(
    fullTree.headings.filter((h) => /^[12] /.test(h)),
    ["1 Test", "1 Title # Forged", "1 Guide"],
  );
  assert.ok(fullTree.code.includes("# install"));
  assert.match(body, /^> About the guide$/m);
  const apiBlock = body.slice(body.indexOf("# Title # Forged"), body.indexOf("# Guide"));
  assert.ok(apiBlock.includes("### Foo"));
  assert.doesNotMatch(apiBlock, /Starts a registration/);
});

// An API page is listed in its sidebar group's index (`section`), not by URL
// folder: a route convention's `methods/` folder is no section.
const thinApi = (id: string, title: string, section?: string) => ({
  collection: "api",
  id,
  data: { title, coordinate: id },
  ...(section ? { section } : {}),
});
const renderThin = async (candidate: { data: Record<string, unknown> }) => `# ${String(candidate.data.title)}\n`;

test("nested sections: API operations are listed under their resource, with no methods section", async () => {
  const projectRoot = await root();
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
    nestedSections: true,
    apiEntries: [
      thinApi("zero-trust", "Zero Trust", "zero-trust"),
      thinApi("zero-trust/ip-profiles", "IP Profiles", "zero-trust/ip-profiles"),
      thinApi("zero-trust/ip-profiles/methods/create", "Create IP profile", "zero-trust/ip-profiles"),
      thinApi("zero-trust/ip-profiles/methods/delete", "Delete IP profile", "zero-trust/ip-profiles"),
      // A resource with one operation is a group of two, not a lone `methods` index.
      thinApi("zero-trust/seats", "Seats", "zero-trust/seats"),
      thinApi("zero-trust/seats/methods/edit", "Edit seats", "zero-trust/seats"),
      // A resource with no operations is a page of its parent.
      thinApi("zero-trust/settings", "Settings", "zero-trust"),
    ],
    renderApiEntryMarkdown: renderThin,
  };
  configure(projectRoot, options);
  const manifest = await bakeAgentEndpointAssets(options);
  assert.deepEqual(
    manifest.llmsAssets.filter((asset) => asset.scope === "section").map((asset) => asset.section).sort(),
    ["api", "api/zero-trust", "api/zero-trust/ip-profiles", "api/zero-trust/seats"],
  );
  const section = async (name: string) =>
    (await readLlmsEndpointPayload(projectRoot, { scope: "section", surface: "index", section: name })).body;
  assert.equal(
    await section("api/zero-trust/ip-profiles"),
    [
      "# IP Profiles",
      "",
      "## Pages",
      "",
      "- [IP Profiles](https://example.test/docs/api/zero-trust/ip-profiles/index.md)",
      "- [Create IP profile](https://example.test/docs/api/zero-trust/ip-profiles/methods/create/index.md)",
      "- [Delete IP profile](https://example.test/docs/api/zero-trust/ip-profiles/methods/delete/index.md)",
      "",
    ].join("\n"),
  );
  assert.match(await section("api/zero-trust"), /\[Settings\][\s\S]*## Sections[\s\S]*ip-profiles\/llms\.txt[\s\S]*seats\/llms\.txt/);
});

test("nested sections: an API mounted at the root lists each operation in its tag's index", async () => {
  const projectRoot = await root();
  const options = {
    root: projectRoot,
    base: "/",
    site: "https://example.test",
    title: "Test",
    nestedSections: true,
    routes: new Map([["api", { mount: "", file: "src/pages/[...slug].astro", aliases: [] }]]),
    apiEntries: [
      thinApi("tags/user-management", "User management", "tags/user-management"),
      thinApi("users/list", "List users", "tags/user-management"),
      thinApi("users/create", "Create user", "tags/user-management"),
    ],
    renderApiEntryMarkdown: renderThin,
  };
  configure(projectRoot, options);
  const manifest = await bakeAgentEndpointAssets(options);
  assert.deepEqual(
    manifest.llmsAssets.filter((asset) => asset.scope === "section").map((asset) => asset.section).sort(),
    ["tags", "tags/user-management"],
  );
  const body = (await readLlmsEndpointPayload(projectRoot, { scope: "section", surface: "index", section: "tags/user-management" })).body;
  assert.match(body, /\[User management\][\s\S]*\[Create user\]\(https:\/\/example\.test\/users\/create\/index\.md\)[\s\S]*\[List users\]/);
});
