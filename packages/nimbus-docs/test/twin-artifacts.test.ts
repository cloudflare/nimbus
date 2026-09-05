import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
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
  bakePreparedTwins,
  configureTwinArtifactRoot,
  ensurePreparedTwins,
  invalidatePreparedTwins,
  isTwinArtifactRequested,
  preparedHeadingsPlugin,
  readPreparedCorpusArtifact,
  readPreparedTwinArtifact,
  registerTwinArtifactDemand,
} from "../src/_internal/twin-artifacts.ts";

const roots: string[] = [];
const capability = { generation: 1, base: "/docs" };

afterEach(async () => {
  clearPreparedMarkdownRegistry();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "nimbus-twins-"));
  roots.push(value);
  beginPreparedMarkdownSession(value);
  return value;
}

function configure(
  projectRoot: string,
  options: Parameters<typeof bakePreparedTwins>[0],
): void {
  configureTwinArtifactRoot(projectRoot, "build", () =>
    bakePreparedTwins(options),
  );
}

function commit(
  root: string,
  collection: string,
  entries: Array<{
    id: string;
    body?: string;
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
  const manifest = await bakePreparedTwins(options);
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
      await readPreparedTwinArtifact(projectRoot, {
        collection: "docs",
        id: "guide",
        surface: "source",
      })
    ).body,
    /## Product heading/,
  );
});

test("bakes expanded source and transformed Markdown artifacts deterministically", async () => {
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
    socialImage: "/docs/og.png",
    indexedCollections: ["docs"],
    citationIndex: new Map([["api:list", "/docs/api/list"]]),
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
  const first = await bakePreparedTwins(options);
  const second = await bakePreparedTwins(options);
  assert.deepEqual(second, first);
  assert.equal(first.artifacts.length, 2);
  assert.equal(first.corpora.length, 2);

  const source = await readPreparedTwinArtifact(projectRoot, {
    collection: "docs",
    id: "guide",
    surface: "source",
  });
  assert.match(source.body, /Hello 😀\./);
  assert.match(source.body, /## 😀/);
  assert.doesNotMatch(source.body, /<Render/);

  const markdown = await readPreparedTwinArtifact(projectRoot, {
    collection: "docs",
    id: "guide",
    surface: "markdown",
  });
  assert.match(markdown.body, /\[Catalog\]\(\/docs:\/docs\/catalog\)/);
  assert.match(markdown.body, /\[Nested\]\(\/nested\)/);
  assert.doesNotMatch(markdown.body, /wrong/);
  assert.match(markdown.body, /\[API\]\(\/docs\/docs\/api\/list\)/);
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
    path.join(projectRoot, ".astro/nimbus/twins/manifest.json"),
    "utf8",
  );
  assert.equal(manifest, `${JSON.stringify(first, null, 2)}\n`);
});

test("bakes site and section corpora from public discoverable prose and API pages", async () => {
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
              sections: [],
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
  const manifest = await bakePreparedTwins(options);
  assert.deepEqual(
    manifest.corpora.map((artifact) =>
      artifact.scope === "site"
        ? `${artifact.scope}:${artifact.surface}`
        : `${artifact.scope}:${artifact.section}`,
    ),
    ["section:api", "section:blog", "section:guide", "site:full", "site:index"],
  );

  const index = await readPreparedCorpusArtifact(projectRoot, {
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

  const guide = await readPreparedCorpusArtifact(projectRoot, {
    scope: "section",
    surface: "index",
    section: "guide",
  });
  assert.match(guide.body, /Guide A/);
  assert.match(guide.body, /Guide B.*Second guide/);
  assert.doesNotMatch(guide.body, /Hidden/);

  const full = await readPreparedCorpusArtifact(projectRoot, {
    scope: "site",
    surface: "full",
  });
  assert.match(full.body, /# Guide A/);
  assert.match(full.body, /\*\*Guide B\*\*/);
  assert.match(full.body, /# API[\s\S]*API reference/);
  assert.match(full.body, /# Post/);
  assert.doesNotMatch(full.body, /# Old|# Hidden|Secret API/);

  assert.ok(
    manifest.artifacts.some(
      (artifact) => artifact.collection === "docs" && artifact.id === "hidden",
    ),
  );
  assert.ok(
    manifest.artifacts.every((artifact) => artifact.collection !== "docs-v1"),
  );
});

test("waits for API index transactions before caching corpus output", async () => {
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
  configureTwinArtifactRoot(projectRoot, "dev", () => {
    return bakePreparedTwins({
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

  await ensurePreparedTwins(projectRoot);
  await update;
  const full = await readPreparedCorpusArtifact(projectRoot, {
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
  configureTwinArtifactRoot(projectRoot, "dev", () => {
    bakes += 1;
    return bakePreparedTwins({
      ...options,
      loadApiEntries: async () => {
        reads += 1;
        if (reads === 1) invalidatePreparedTwins(projectRoot);
        return [apiPage(reads === 1 ? "Old API" : "New API")];
      },
    });
  });

  const manifest = await ensurePreparedTwins(projectRoot);
  assert.equal(bakes, 2);
  assert.deepEqual(
    (
      await readdir(path.join(projectRoot, ".astro/nimbus/twins/artifacts"))
    ).sort(),
    [...manifest.artifacts, ...manifest.corpora]
      .map((artifact) => path.basename(artifact.path))
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
    bakePreparedTwins(options),
    /guide\/llms\.txt.*collides with the generated corpus route/s,
  );

  commit(projectRoot, "docs", [
    { id: "guide", body: "Guide", data: { title: "Guide" } },
    { id: "guide/index", body: "Index", data: { title: "Index" } },
  ]);
  await assert.rejects(
    bakePreparedTwins(options),
    /guide\/index.*collides with.*docs:guide.*generated twin route/s,
  );

  commit(projectRoot, "docs", [
    { id: "../secret", body: "Secret", data: { title: "Secret" } },
  ]);
  await assert.rejects(bakePreparedTwins(options), /section slug is unsafe/);

  commit(projectRoot, "docs", [
    {
      id: "guide/%252e%252e/secret",
      body: "Secret",
      data: { title: "Secret" },
    },
  ]);
  await assert.rejects(bakePreparedTwins(options), /unsafe entry ID/);

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
    bakePreparedTwins(options),
    /guide\/llms\.txt.*collides with the generated corpus route/s,
  );
});

test("uses locale-independent ordering in corpus indexes", async () => {
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
  await bakePreparedTwins(options);
  const index = await readPreparedCorpusArtifact(projectRoot, {
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
  await bakePreparedTwins(options);
  const markdown = await readPreparedTwinArtifact(projectRoot, {
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

  const manifest = await bakePreparedTwins({
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
    indexedCollections: ["docs"],
  });
  assert.deepEqual(
    manifest.artifacts.map(({ id, surface }) => [id, surface]),
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
    bakePreparedTwins(options),
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
    bakePreparedTwins(options),
    /visibility is unknown.*docs:guide/s,
  );
});

test("rejects unprepared collections and stale collection capabilities", async () => {
  const projectRoot = await root();
  await assert.rejects(
    bakePreparedTwins({
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
    bakePreparedTwins({
      root: projectRoot,
      base: "/docs",
      site: "https://example.test",
      title: "Test",
      indexedCollections: ["docs"],
    }),
    /collection "docs".*not prepared/s,
  );
});

test("prepares headings without requiring every indexed collection to support twins", async () => {
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

  let twinBakes = 0;
  configureTwinArtifactRoot(
    projectRoot,
    "build",
    async () => {
      twinBakes += 1;
      throw new Error("strict twin bake should not run");
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
  assert.equal(twinBakes, 0);
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

test("joins concurrent rebakes and rejects symlinked artifact roots", async () => {
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
  configureTwinArtifactRoot(projectRoot, "dev", async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return bakePreparedTwins(options);
  });
  const [first, second] = await Promise.all([
    ensurePreparedTwins(projectRoot),
    ensurePreparedTwins(projectRoot),
  ]);
  assert.deepEqual(second, first);
  assert.equal(calls, 1);

  const escapedRoot = await root();
  commit(escapedRoot, "docs", [
    { id: "guide", body: "Guide", data: { title: "Guide" } },
  ]);
  const outside = await root();
  await mkdir(path.join(escapedRoot, ".astro/nimbus"), { recursive: true });
  await symlink(outside, path.join(escapedRoot, ".astro/nimbus/twins"), "dir");
  await assert.rejects(
    bakePreparedTwins({ ...options, root: escapedRoot }),
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
  configureTwinArtifactRoot(projectRoot, "dev", async () => {
    calls += 1;
    const manifest = await bakePreparedTwins(options);
    if (calls === 1) {
      entered?.();
      await gate;
    }
    return manifest;
  });

  const read = ensurePreparedTwins(projectRoot);
  await started;
  invalidatePreparedTwins(projectRoot);
  release?.();
  await read;
  assert.equal(calls, 2);
});

test("removes artifacts made obsolete by edits and deletions", async () => {
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
  await bakePreparedTwins(options);

  configure(projectRoot, options);

  commit(projectRoot, "docs", [
    { id: "guide", body: "New guide", data: { title: "Guide" } },
  ]);
  const manifest = await bakePreparedTwins(options);
  const files = await readdir(
    path.join(projectRoot, ".astro/nimbus/twins/artifacts"),
  );
  assert.deepEqual(
    files.sort(),
    [...manifest.artifacts, ...manifest.corpora]
      .map((artifact) => path.basename(artifact.path))
      .sort(),
  );
});

test("scopes artifact demand to the current configuration session", async () => {
  const projectRoot = await root();
  const options = {
    root: projectRoot,
    base: "/docs",
    site: "https://example.test",
    title: "Test",
    indexedCollections: ["docs"],
  };
  configure(projectRoot, options);
  registerTwinArtifactDemand(projectRoot);
  assert.equal(isTwinArtifactRequested(projectRoot), true);

  configure(projectRoot, options);
  assert.equal(isTwinArtifactRequested(projectRoot), false);
});
