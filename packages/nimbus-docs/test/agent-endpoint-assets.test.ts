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

const roots: string[] = [];
const capability = { generation: 1, base: "/docs" };

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
): void {
  const key = preparedMarkdownRootKey(root);
  const epoch = beginPreparedMarkdownLoad(key, collection, false);
  assert.equal(
    commitPreparedMarkdownCollection(
      key,
      collection,
      epoch,
      capability,
      entries.map((entry) => ({
        id: entry.id,
        body: entry.body,
        filePath: entry.filePath,
        data: { ...entry.data },
      })) as never,
      new Map(entries.map((entry) => [entry.id, entry.headings ?? []])),
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
    indexedCollections: ["api"],
    apiCollections: ["api"],
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
    indexedCollections: ["docs"],
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
    indexedCollections: ["docs"],
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
    indexedCollections: ["docs"],
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
  assert.match(markdown.body, /\[Catalog\]\(\/docs:\/docs\/catalog\)/);
  assert.equal(markdown.mediaType, "text/markdown; charset=utf-8");
  assert.match(markdown.body, /\[Nested\]\(\/nested\)/);
  assert.doesNotMatch(markdown.body, /wrong/);
  assert.match(markdown.body, /\[API\]\(\/docs\/api\/list\)/);
  assert.match(
    markdown.body,
    /image: "https:\/\/example\.test\/docs\/og\.png"/,
  );
  assert.match(
    markdown.body,
    /Source: https:\/\/example\.test\/docs\/guide\/index\.mdx/,
  );
  assert.doesNotMatch(markdown.body, /__nimbusMarkdown/);
  assert.match(markdown.content, /\[Catalog\]\(\/docs:\/docs\/catalog\)/);
  assert.doesNotMatch(markdown.content, /Documentation Index|Source:|^---/m);

  const manifest = await readFile(
    path.join(projectRoot, ".astro/nimbus/agent-endpoint-assets/manifest.json"),
    "utf8",
  );
  assert.equal(manifest, `${JSON.stringify(first, null, 2)}\n`);
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
    indexedCollections: ["blog", "docs-v1", "docs", "api"],
    apiCollections: ["api"],
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
    /\[guide\]\(https:\/\/example\.test\/docs\/guide\/llms\.txt\)/,
  );
  assert.match(
    index.body,
    /\[api\]\(https:\/\/example\.test\/docs\/api\/llms\.txt\)/,
  );
  assert.doesNotMatch(index.body, /v1|Hidden/);

  const guide = await readLlmsEndpointPayload(projectRoot, {
    scope: "section",
    surface: "index",
    section: "guide",
  });
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
  assert.match(full.body, /\[Users\]\(\/docs\/api\/tags\/users\)/);
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
    indexedCollections: ["docs"],
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
  assert.equal(isAgentEndpointAssetRequested(projectRoot), true);

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
    indexedCollections: ["docs"],
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
    indexedCollections: ["docs", "api"],
    apiCollections: ["api"],
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
    indexedCollections: ["docs"],
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
    indexedCollections: ["docs"],
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
    indexedCollections: ["docs"],
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
    indexedCollections: ["docs"],
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
    indexedCollections: ["docs"],
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
    indexedCollections: ["docs"],
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

test("rejects unprepared collections and stale collection capabilities", async () => {
  const projectRoot = await root();
  await assert.rejects(
    bakeAgentEndpointAssets({
      root: projectRoot,
      base: "/docs",
      site: "https://example.test",
      title: "Test",
      indexedCollections: ["custom"],
    }),
    /withNimbusMarkdown/,
  );

  commit(projectRoot, "docs", [
    { id: "guide", body: "Guide", data: { title: "Guide" } },
  ]);
  const key = preparedMarkdownRootKey(projectRoot);
  const epoch = beginPreparedMarkdownLoad(key, "docs", false);
  commitPreparedMarkdownCollection(
    key,
    "docs",
    epoch,
    { generation: 1, base: "/wrong" },
    [{ id: "guide", body: "Guide", data: { title: "Guide" } }] as never,
  );
  await assert.rejects(
    bakeAgentEndpointAssets({
      root: projectRoot,
      base: "/docs",
      site: "https://example.test",
      title: "Test",
      indexedCollections: ["docs"],
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
    indexedCollections: ["docs", "bodyless", "unwrapped"],
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
        indexedCollections: ["docs", "bodyless", "unwrapped"],
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
    indexedCollections: ["docs"],
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
    indexedCollections: ["docs"],
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
    indexedCollections: ["docs"],
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
    indexedCollections: ["docs"],
  };
  configure(projectRoot, options);
  registerAgentEndpointAssetDemand(projectRoot);
  assert.equal(isAgentEndpointAssetRequested(projectRoot), true);

  configure(projectRoot, options);
  assert.equal(isAgentEndpointAssetRequested(projectRoot), false);
});
