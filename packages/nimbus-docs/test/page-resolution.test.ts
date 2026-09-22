import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { CollectionEntry } from "astro:content";

import type { ApiNav, ApiPageProps } from "../src/api/index.js";
import {
  resolveApiPage,
  resolveProsePage,
  type PageResolution,
  type PageResolutionContext,
  type ProsePage,
} from "../src/_internal/page-resolution.js";
import type { ApiSpec } from "../src/types.js";
import {
  getApiPage,
  getCollectionPageProps,
  getDocsPageProps,
} from "../src/index.js";

function context(
  pathname: string,
  slug: string | undefined,
  props: Record<string, unknown> = {},
): PageResolutionContext {
  return {
    props,
    params: { slug },
    url: new URL(pathname, "https://example.com"),
    projection: { audience: { key: "test" } },
  };
}

function entry(
  collection: string,
  id: string,
  data: Record<string, unknown> = {},
): CollectionEntry<string> {
  return { collection, id, data, body: `# ${id}` };
}

const Content = (() => undefined) as unknown as ProsePage["Content"];

test("the shared contract represents redirect outcomes", () => {
  const resolution: PageResolution = {
    status: "redirect",
    location: "/current/",
    permanent: true,
  };
  assert.equal(resolution.status, "redirect");
});

test("public static helpers preserve missing-prop diagnostics", async () => {
  await assert.rejects(
    () => getDocsPageProps({ props: {} } as never),
    /expected `entry` in Astro\.props/,
  );
  await assert.rejects(
    () => getCollectionPageProps({ props: {} } as never),
    /expected `entry` in Astro\.props/,
  );
  await assert.rejects(
    () => getApiPage({ props: {} } as never),
    /expected `collection` and `coordinate` in Astro\.props/,
  );
});

describe("prose page resolution", () => {
  const entries = new Map([
    ["docs:index", entry("docs", "index")],
    ["docs:guides/setup", entry("docs", "guides/setup")],
    ["docs-v1:index", entry("docs-v1", "index")],
    ["docs-v1:v1", entry("docs-v1", "v1")],
    ["docs-v1:guides/setup", entry("docs-v1", "guides/setup")],
    ["blog:v1", entry("blog", "v1")],
  ]);
  let lookups: Array<{ collection: string; id: string; audience?: string }> =
    [];
  const dependencies = {
    async getVisibleEntry(
      collection: string,
      id: string,
      projection?: PageResolutionContext["projection"],
    ) {
      lookups.push({ collection, id, audience: projection?.audience?.key });
      return entries.get(`${collection}:${id}`) ?? null;
    },
    async getVersions() {
      return { others: ["v1"] };
    },
    async render(value: CollectionEntry<string>) {
      return {
        Content,
        headings: [
          { depth: 1, text: value.id, slug: value.id.replaceAll("/", "-") },
        ],
      };
    },
  };

  test("uses an existing static entry without a collection lookup", async () => {
    lookups = [];
    const staticEntry = entry("docs", "static");
    const result = await resolveProsePage(
      context("/static/", "wrong", { entry: staticEntry }),
      { collection: "docs" },
      dependencies,
    );

    assert.equal(result.status, "found");
    if (result.status !== "found") return;
    assert.equal(result.page.entry, staticEntry);
    assert.equal(result.page.identity.pathname, "/static");
    assert.deepEqual(lookups, []);
  });

  test("resolves the root and nested docs paths through visible content", async () => {
    lookups = [];
    const root = await resolveProsePage(
      context("/", undefined),
      { collection: "docs" },
      dependencies,
    );
    const nested = await resolveProsePage(
      context("/guides/setup/", "guides/setup"),
      { collection: "docs" },
      dependencies,
    );

    assert.equal(root.status, "found");
    assert.equal(nested.status, "found");
    assert.deepEqual(lookups, [
      { collection: "docs", id: "index", audience: "test" },
      { collection: "docs", id: "guides/setup", audience: "test" },
    ]);
  });

  test("strips the leading prose version from root catch-all IDs", async () => {
    const versionRoot = await resolveProsePage(
      context("/v1/", "v1"),
      { collection: "docs" },
      dependencies,
    );
    const versionLeaf = await resolveProsePage(
      context("/v1/guides/setup/", "v1/guides/setup"),
      { collection: "docs" },
      dependencies,
    );
    const missing = await resolveProsePage(
      context("/missing/", "missing"),
      { collection: "docs" },
      dependencies,
    );

    assert.equal(versionRoot.status, "found");
    if (versionRoot.status === "found") {
      assert.equal(versionRoot.page.identity.collection, "docs-v1");
      assert.equal(versionRoot.page.entry.id, "index");
    }
    assert.equal(versionLeaf.status, "found");
    if (versionLeaf.status === "found") {
      assert.equal(versionLeaf.page.identity.collection, "docs-v1");
      assert.equal(versionLeaf.page.entry.id, "guides/setup");
    }
    assert.deepEqual(missing, { status: "not-found" });
  });

  test("does not strip version-like IDs inside mounted collection routes", async () => {
    const versionLeaf = await resolveProsePage(
      context("/v1/v1/", "v1"),
      {},
      dependencies,
    );
    const blogLeaf = await resolveProsePage(
      context("/blog/v1/", "v1"),
      {},
      dependencies,
    );

    assert.equal(versionLeaf.status, "found");
    if (versionLeaf.status === "found") {
      assert.equal(versionLeaf.page.identity.collection, "docs-v1");
      assert.equal(versionLeaf.page.entry.id, "v1");
    }
    assert.equal(blogLeaf.status, "found");
    if (blogLeaf.status === "found") {
      assert.equal(blogLeaf.page.identity.collection, "blog");
      assert.equal(blogLeaf.page.entry.id, "v1");
    }
  });
});

describe("API page resolution", () => {
  const api: ApiSpec[] = [
    {
      collection: "api",
      versions: [
        { version: "v2", spec: {}, default: true },
        { version: "v1", spec: {} },
      ],
    },
  ];
  const entries = new Map([
    ["api:index", entry("api", "index", { coordinate: "root", version: "v2" })],
    [
      "api:charges/create",
      entry("api", "charges/create", {
        coordinate: "createCharge",
        version: "v2",
      }),
    ],
    ["api:v1", entry("api", "v1", { coordinate: "root", version: "v1" })],
    [
      "api:v1/charges/create",
      entry("api", "v1/charges/create", {
        coordinate: "createCharge",
        version: "v1",
      }),
    ],
  ]);
  let lookups: Array<{ collection: string; id: string; audience?: string }> =
    [];
  let collectionLoads = 0;
  const dependencies = {
    async getApiCollections() {
      collectionLoads++;
      return api.map(({ collection }) => collection);
    },
    async getVisibleEntry(
      collection: string,
      id: string,
      projection?: PageResolutionContext["projection"],
    ) {
      lookups.push({ collection, id, audience: projection?.audience?.key });
      return entries.get(`${collection}:${id}`) ?? null;
    },
    async render(
      collection: string,
      version: string | null,
      coordinate: string,
    ) {
      const page: ApiPageProps = {
        apiSchemaVersion: 1,
        kind: "api",
        collection,
        coordinate,
        href: "/api",
        markdownHref: "/api/index.md",
        title: coordinate,
        breadcrumbs: [],
        servers: [],
        sections: [],
        ...(version ? { version } : {}),
      };
      const nav: ApiNav = { apiSchemaVersion: 1, collection, items: [] };
      return { page, nav };
    },
  };

  test("resolves a static API identity by its lightweight route props", async () => {
    lookups = [];
    collectionLoads = 0;
    const result = await resolveApiPage(
      context("/api/charges/create/", "charges/create", {
        collection: "api",
        version: "v2",
        coordinate: "createCharge",
      }),
      {},
      dependencies,
    );

    assert.equal(result.status, "found");
    if (result.status !== "found") return;
    assert.equal(result.page.coordinate, "createCharge");
    assert.equal(result.page.version, "v2");
    assert.deepEqual(lookups, [
      { collection: "api", id: "charges/create", audience: "test" },
    ]);
    assert.equal(collectionLoads, 0);
  });

  test("resolves default root and nested API request paths", async () => {
    lookups = [];
    const root = await resolveApiPage(
      context("/base/api/", undefined),
      {},
      dependencies,
    );
    const nested = await resolveApiPage(
      context("/base/api/charges/create/", "charges/create"),
      {},
      dependencies,
    );

    assert.equal(root.status, "found");
    assert.equal(nested.status, "found");
    assert.deepEqual(lookups, [
      { collection: "api", id: "index", audience: "test" },
      { collection: "api", id: "charges/create", audience: "test" },
    ]);
  });

  test("resolves version roots and leaves from their indexed store IDs", async () => {
    const root = await resolveApiPage(
      context("/api/v1/", "v1"),
      {},
      dependencies,
    );
    const leaf = await resolveApiPage(
      context("/api/v1/charges/create/", "v1/charges/create"),
      {},
      dependencies,
    );

    assert.equal(root.status, "found");
    assert.equal(leaf.status, "found");
    if (root.status === "found") assert.equal(root.page.version, "v1");
    if (leaf.status === "found")
      assert.equal(leaf.page.coordinate, "createCharge");
  });

  test("returns not-found for missing and unknown API paths", async () => {
    const missing = await resolveApiPage(
      context("/api/missing/", "missing"),
      {},
      dependencies,
    );
    const unknown = await resolveApiPage(
      context("/unknown/", undefined),
      {},
      dependencies,
    );
    const rootAlias = await resolveApiPage(
      context("/api/index/", "index"),
      {},
      dependencies,
    );

    assert.deepEqual(missing, { status: "not-found" });
    assert.deepEqual(unknown, { status: "not-found" });
    assert.deepEqual(rootAlias, { status: "not-found" });
  });

  test("preserves an unversioned API's null version", async () => {
    const result = await resolveApiPage(
      context("/legacy/", undefined),
      { collection: "legacy" },
      {
        ...dependencies,
        async getApiCollections() {
          return ["legacy"];
        },
        async getVisibleEntry() {
          return entry("legacy", "index", { coordinate: "root" });
        },
      },
    );

    assert.equal(result.status, "found");
    if (result.status === "found") assert.equal(result.page.version, null);
  });
});
