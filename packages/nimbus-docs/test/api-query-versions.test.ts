// Query-addressed API versions (`versionUrl: { in: "query" }`). Pins the config
// rules (query needs `versions` and effective request rendering; dotted
// version ids are valid in both modes), the one URL builder every producer
// goes through, `(version, slug) → entry` route resolution where store ids
// are never routes, the query-form alternates/citations, the bounded-nav
// overview URL, and the hidden-version sitemap rule. Path mode must stay
// byte-identical, so its shapes are pinned here too.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import type { CollectionEntry } from "astro:content";

import { validateNimbusConfig } from "../src/_internal/validate.js";
import {
  apiVersionQuery,
  apiQueryRouting,
  pageUrl,
  resolveApiFamily,
  selectApiVersion,
} from "../src/_internal/api/resolve-versions.js";
import { buildApiVersionAlternates } from "../src/_internal/api/api-alternates.js";
import { buildCitationIndex } from "../src/_internal/api/citation-index.js";
import { applyApiSidebarMode } from "../src/_internal/api/nav-bounds.js";
import { hiddenVersionPrefixes } from "../src/_internal/hidden-sitemap.js";
import {
  resolveApiPage,
  type PageResolutionContext,
} from "../src/_internal/page-resolution.js";
import {
  buildApiModel,
  clearApiModelCache,
  getApiPageProps,
} from "../src/api/index.js";
import type { ApiNav, ApiPageProps } from "../src/api/index.js";
import type { ApiSpec, NimbusConfig } from "../src/types.js";

const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/api/", import.meta.url));

function spec(ops: Array<[string, string, string]>): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [method, path, operationId] of ops) {
    paths[path] = {
      ...(paths[path] ?? {}),
      [method]: {
        operationId,
        summary: operationId,
        responses: { "200": { description: "ok" } },
      },
    };
  }
  return {
    openapi: "3.0.0",
    info: { title: "QV", version: "1.0.0" },
    paths,
  };
}

function withApi(api: unknown, rendering?: unknown): unknown {
  return {
    site: "https://example.com",
    title: "T",
    api,
    ...(rendering !== undefined ? { rendering } : {}),
  };
}

describe("versionUrl config rules", () => {
  const family = (extra: Record<string, unknown> = {}) => [
    {
      collection: "api",
      versionUrl: { in: "query" },
      versions: [
        { version: "v2", spec: "./v2.yaml", default: true },
        { version: "v1", spec: "./v1.yaml" },
      ],
      ...extra,
    },
  ];

  test("query mode with versions and request rendering validates", () => {
    assert.doesNotThrow(() =>
      validateNimbusConfig(withApi(family(), { default: "request" })),
    );
    assert.doesNotThrow(() =>
      validateNimbusConfig(
        withApi(family(), { default: "build", collections: { api: "request" } }),
      ),
    );
  });

  test("query mode on a single-spec entry fails", () => {
    assert.throws(
      () =>
        validateNimbusConfig(
          withApi(
            [
              {
                collection: "api",
                versionUrl: { in: "query" },
                spec: "./openapi.yaml",
              },
            ],
            { default: "request" },
          ),
        ),
      /versionUrl: \{ in: "query" \} without "versions"/,
    );
  });

  test("query mode needs the family's EFFECTIVE rendering to be request", () => {
    // No rendering config at all: effective default is "build".
    assert.throws(
      () => validateNimbusConfig(withApi(family())),
      /query versions need request rendering: a static site serves the same file whatever the query says/,
    );
    // The trap the collection override sets: a request default does not help
    // a family whose own override says build.
    assert.throws(
      () =>
        validateNimbusConfig(
          withApi(family(), { default: "request", collections: { api: "build" } }),
        ),
      /effective rendering mode is "build"/,
    );
  });

  test("dotted version ids validate in both modes; reserved ids still fail", () => {
    const versions = [
      { version: "2026-11-30.air", spec: "./a.yaml", default: true },
      { version: "2025-01-01", spec: "./b.yaml" },
    ];
    assert.doesNotThrow(() =>
      validateNimbusConfig(withApi([{ collection: "api", versions }])),
    );
    assert.doesNotThrow(() =>
      validateNimbusConfig(
        withApi(
          [{ collection: "api", versionUrl: { in: "query" }, versions }],
          {
            default: "request",
          },
        ),
      ),
    );
    assert.throws(() =>
      validateNimbusConfig(
        withApi([
          {
            collection: "api",
            versions: [{ version: "tags", spec: "./a.yaml" }],
          },
        ]),
      ),
    );
    // A version id starts and ends with a letter or digit.
    for (const version of [".air", "-v1", "v1-", "v1."]) {
      assert.throws(
        () =>
          validateNimbusConfig(
            withApi([{ collection: "api", versions: [{ version, spec: "./a.yaml" }] }]),
          ),
        /start and end with a letter or digit/,
        version,
      );
    }
  });
});

describe("pageUrl — the one URL builder", () => {
  const family: ApiSpec = {
    collection: "qv",
    versionUrl: { in: "query" },
    versions: [
      { version: "v2", spec: "v2.yaml", default: true },
      { version: "2026-11-30.air", spec: "v1.yaml" },
    ],
  };
  const targets = resolveApiFamily(family);
  const def = targets.find((t) => t.isDefault)!;
  const old = targets.find((t) => !t.isDefault)!;

  test("query mode: every version shares the version-free path; only non-defaults carry the query", () => {
    assert.equal(pageUrl(def, ""), "/qv/");
    assert.equal(pageUrl(def, "charges/create"), "/qv/charges/create/");
    assert.equal(apiVersionQuery(def), "");
    assert.equal(pageUrl(old, ""), "/qv/?version=2026-11-30.air");
    assert.equal(
      pageUrl(old, "charges/create"),
      "/qv/charges/create/?version=2026-11-30.air",
    );
  });

  test("path mode is byte-identical to the mount-path URLs it always had", () => {
    const pathTargets = resolveApiFamily({
      collection: "core",
      versions: [
        { version: "v2", spec: "v2.yaml", default: true },
        { version: "v1", spec: "v1.yaml" },
      ],
    });
    for (const t of pathTargets) {
      assert.equal(t.versionMode, "path");
      assert.equal(apiVersionQuery(t), "");
      assert.equal(
        pageUrl(t, "charges/create"),
        `${t.mountPath}/charges/create/`,
      );
    }
    const single = resolveApiFamily({ collection: "solo", spec: "a.yaml" })[0]!;
    assert.equal(single.versionMode, "path");
    assert.equal(pageUrl(single, ""), "/solo/");
  });

  test("versionUrl.param renames the query every link carries", () => {
    const renamed = resolveApiFamily({
      ...family,
      versionUrl: { in: "query", param: "api-version" },
    });
    const old = renamed.find((t) => !t.isDefault)!;
    assert.equal(
      pageUrl(old, "charges/create"),
      "/qv/charges/create/?api-version=2026-11-30.air",
    );
  });
});

describe("alternates and citations carry the query form", () => {
  const api: ApiSpec[] = [
    {
      collection: "qv",
      versionUrl: { in: "query" },
      versions: [
        {
          version: "v2",
          spec: spec([
            ["get", "/pets", "list-pets"],
            ["post", "/pets", "create-pet"],
          ]),
          default: true,
        },
        {
          version: "v1",
          spec: spec([
            ["get", "/pets", "list-pets"],
            ["get", "/legacy", "legacy-report"],
          ]),
        },
      ],
    },
  ];

  test("self URLs are query-form; canonical is the default's version-free URL; old-only pages have none", async () => {
    clearApiModelCache("qv");
    const table = await buildApiVersionAlternates(api, FIXTURE_ROOT);

    const v1 = table["qv@v1:list-pets"];
    assert.ok(v1);
    assert.equal(v1!.self.url, "/qv/list-pets/?version=v1");
    assert.equal(v1!.canonical!.url, "/qv/list-pets/");
    const v2 = table["qv@v2:list-pets"];
    assert.equal(v2!.self.url, "/qv/list-pets/");
    assert.equal(v2!.canonical, null, "the default is self-canonical");
    assert.equal(
      v2!.alternates.find((a) => a.version === "v1")!.url,
      "/qv/list-pets/?version=v1",
      "picker entries carry their destination's query",
    );

    const oldOnly = table["qv@v1:legacy-report"];
    assert.ok(oldOnly, "an old-only operation still has a record");
    assert.equal(oldOnly!.self.url, "/qv/legacy-report/?version=v1");
    assert.equal(
      oldOnly!.canonical,
      null,
      "no default counterpart means no canonical at all",
    );
  });

  test("citations for a non-default version use the query form", async () => {
    clearApiModelCache("qv");
    const { index } = await buildCitationIndex(api, FIXTURE_ROOT);
    assert.equal(index.get("qv:list-pets"), "/qv/list-pets");
    assert.equal(index.get("qv@v2:list-pets"), "/qv/list-pets");
    assert.equal(index.get("qv@v1:list-pets"), "/qv/list-pets?version=v1");
    assert.equal(index.get("qv@v1:qv"), "/qv?version=v1");
    assert.equal(
      index.get("qv@v1:list-pets.response.200"),
      "/qv/list-pets?version=v1#response-200",
      "anchored citations keep the query before the fragment",
    );
  });
});

test("a deferred page-less group on an old-version page loads that version's overview", () => {
  const nav: ApiNav = {
    apiSchemaVersion: 1,
    collection: "qv",
    items: [
      {
        label: "Pets",
        children: [
          {
            label: "List pets",
            href: "/qv/list-pets?version=v1",
            children: [],
          },
        ],
      },
    ],
  } as unknown as ApiNav;
  const bound = applyApiSidebarMode(nav, {
    mode: "on-demand",
    mountPath: "/qv/v1",
    urlBasePath: "/qv",
    urlQuery: "?version=v1",
  });
  const group = bound.items[0]!;
  assert.equal(group.deferred, true);
  assert.equal(group.childrenHref, "/qv/?version=v1");
});

test("one spec never aliases path-form and query-form models in the cache", async () => {
  // Citation/alternates builders and the content loader share the model
  // cache; the URL fields are part of the output, so they are part of the
  // key — whichever builds first must not poison the other.
  const inline = spec([["get", "/ping", "ping"]]);
  const plain = await buildApiModel({
    collection: "alias",
    spec: inline,
    mountPath: "/alias/v1",
  });
  const query = await buildApiModel({
    collection: "alias",
    spec: inline,
    mountPath: "/alias/v1",
    urlBasePath: "/alias",
    urlQuery: "?version=v1",
  });
  assert.equal(getApiPageProps(plain, "ping").href, "/alias/v1/ping/");
  assert.equal(getApiPageProps(plain, "ping").markdownHref, "/alias/v1/ping/index.md");
  assert.equal(getApiPageProps(query, "ping").href, "/alias/ping/?version=v1");
  assert.equal(getApiPageProps(query, "ping").markdownHref, undefined);
});

describe("hidden versions and the sitemap", () => {
  test("a query-mode hidden version contributes no prefix (it has no version-free URLs)", () => {
    const config = {
      title: "t",
      api: [
        {
          collection: "qv",
          versionUrl: { in: "query" },
          versions: [
            { version: "v2", spec: "a.yaml", default: true },
            { version: "v0", spec: "b.yaml", hidden: true },
          ],
        },
      ],
    } as unknown as NimbusConfig;
    assert.deepEqual(hiddenVersionPrefixes(config), []);
  });

  test("a path-mode hidden version still excludes its mount prefix", () => {
    const config = {
      title: "t",
      api: [
        {
          collection: "core",
          versions: [
            { version: "v2", spec: "a.yaml", default: true },
            { version: "v0", spec: "b.yaml", hidden: true },
          ],
        },
      ],
    } as unknown as NimbusConfig;
    assert.deepEqual(hiddenVersionPrefixes(config), ["/core/v0"]);
  });
});

describe("query-mode route resolution — (version, slug) → entry", () => {
  function context(
    pathname: string,
    slug: string | undefined,
  ): PageResolutionContext {
    return {
      props: {},
      params: { slug },
      url: new URL(pathname, "https://example.com"),
      projection: { audience: { key: "test" } },
    };
  }

  function entry(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): CollectionEntry<string> {
    return { collection, id, data, body: "" } as CollectionEntry<string>;
  }

  const entries = new Map([
    ["qv:index", entry("qv", "index", { coordinate: "root", version: "v2" })],
    [
      "qv:list-pets",
      entry("qv", "list-pets", { coordinate: "list-pets", version: "v2" }),
    ],
    ["qv:v1", entry("qv", "v1", { coordinate: "root", version: "v1" })],
    [
      "qv:v1/list-pets",
      entry("qv", "v1/list-pets", { coordinate: "list-pets", version: "v1" }),
    ],
    [
      "qv:v1/legacy-report",
      entry("qv", "v1/legacy-report", {
        coordinate: "legacy-report",
        version: "v1",
      }),
    ],
    [
      "qv:v0/list-pets",
      entry("qv", "v0/list-pets", { coordinate: "list-pets", version: "v0" }),
    ],
    [
      "core:charges/create",
      entry("core", "charges/create", {
        coordinate: "createCharge",
        version: "v2",
      }),
    ],
  ]);

  const dependencies = {
    async getApiCollections() {
      return ["qv", "core"];
    },
    async getApiQueryRouting(collection: string) {
      if (collection !== "qv") return null;
      return {
        defaultVersion: "v2",
        versions: new Set(["v2", "v1", "v0"]),
        param: "version",
      };
    },
    async getVisibleEntry(collection: string, id: string) {
      return entries.get(`${collection}:${id}`) ?? null;
    },
    async render(collection: string, version: string | null, coordinate: string) {
      const page: ApiPageProps = {
        apiSchemaVersion: 1,
        kind: "api",
        collection,
        coordinate,
        href: "/qv",
        markdownHref: "/qv/index.md",
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

  async function resolve(pathname: string, slug: string | undefined) {
    return resolveApiPage(context(pathname, slug), {}, dependencies);
  }

  test("no query and ?version=<default> and ?version= (empty) all render the default", async () => {
    for (const path of [
      "/qv/list-pets/",
      "/qv/list-pets/?version=v2",
      "/qv/list-pets/?version=",
    ]) {
      const result = await resolve(path, "list-pets");
      assert.equal(result.status, "found", path);
      if (result.status === "found") assert.equal(result.page.version, "v2");
    }
  });

  test("?version=<other> selects that version's entry", async () => {
    const result = await resolve("/qv/list-pets/?version=v1", "list-pets");
    assert.equal(result.status, "found");
    if (result.status === "found") assert.equal(result.page.version, "v1");
  });

  test("an unknown version id is a 404", async () => {
    const result = await resolve("/qv/list-pets/?version=nope", "list-pets");
    assert.equal(result.status, "not-found");
  });

  test("version given more than once is a 404, whatever the values", async () => {
    for (const query of ["version=v1&version=v1", "version=v1&version=nope"]) {
      const result = await resolve(`/qv/list-pets/?${query}`, "list-pets");
      assert.equal(result.status, "not-found", query);
    }
  });

  test("store ids are not routes: a version-prefixed path 404s without the query, hidden included", async () => {
    // The lookup finds the id "v1/list-pets" under the default version, sees
    // it belongs to v1, and refuses.
    for (const slug of ["v1/list-pets", "v0/list-pets", "v1"]) {
      const result = await resolve(`/qv/${slug}/`, slug);
      assert.equal(result.status, "not-found", slug);
    }
  });

  test("a slug only in an old version 404s without the query and renders with it", async () => {
    const bare = await resolve("/qv/legacy-report/", "legacy-report");
    assert.equal(bare.status, "not-found");
    const versioned = await resolve(
      "/qv/legacy-report/?version=v1",
      "legacy-report",
    );
    assert.equal(versioned.status, "found");
    if (versioned.status === "found")
      assert.equal(versioned.page.version, "v1");
  });

  test("a hidden version is reachable by its query", async () => {
    const result = await resolve("/qv/list-pets/?version=v0", "list-pets");
    assert.equal(result.status, "found");
    if (result.status === "found") assert.equal(result.page.version, "v0");
  });

  test("a path-mode family ignores the parameter entirely", async () => {
    const result = await resolve(
      "/core/charges/create/?version=bogus",
      "charges/create",
    );
    assert.equal(result.status, "found");
    if (result.status === "found") assert.equal(result.page.version, "v2");
  });

  test("0.17's ?api-version= redirects permanently to ?version=, keeping other params", async () => {
    const result = await resolve(
      "/qv/list-pets/?utm_source=x&api-version=v1",
      "list-pets",
    );
    assert.deepEqual(result, {
      status: "redirect",
      location: "/qv/list-pets/?utm_source=x&version=v1",
      permanent: true,
    });
  });

  test("?api-version= with an unknown id is a 404, not a redirect", async () => {
    const result = await resolve(
      "/qv/list-pets/?api-version=nope",
      "list-pets",
    );
    assert.equal(result.status, "not-found");
  });

  test("?version= wins over a stray ?api-version=", async () => {
    const result = await resolve(
      "/qv/list-pets/?version=v1&api-version=v0",
      "list-pets",
    );
    assert.equal(result.status, "found");
    if (result.status === "found") assert.equal(result.page.version, "v1");
  });
});

describe("versionUrl.param", () => {
  const routing = {
    defaultVersion: "v2",
    versions: new Set(["v2", "v1"]),
    param: "v",
  };

  test("a custom name selects; the 0.17 name still selects; other names don't", () => {
    assert.equal(selectApiVersion(new URLSearchParams("v=v1"), routing), "v1");
    assert.equal(
      selectApiVersion(new URLSearchParams("api-version=v1"), routing),
      "v1",
    );
    assert.equal(
      selectApiVersion(new URLSearchParams("version=v1"), routing),
      "v2",
    );
  });

  test("only query mode routes by query: a path-versioned family ignores ?version=", () => {
    const versions = [
      { version: "v2", spec: "v2.yaml", default: true },
      { version: "v1", spec: "v1.yaml" },
    ];
    assert.equal(
      apiQueryRouting([{ collection: "core", versions }], "core"),
      null,
    );
    assert.equal(
      apiQueryRouting(
        [
          {
            collection: "qv",
            versionUrl: { in: "query", param: "v" },
            versions,
          },
        ],
        "qv",
      )?.param,
      "v",
    );
  });

  const family = (extra: Record<string, unknown>) => [
    {
      collection: "api",
      versions: [
        { version: "v2", spec: "./v2.yaml", default: true },
        { version: "v1", spec: "./v1.yaml" },
      ],
      ...extra,
    },
  ];

  const check = (extra: Record<string, unknown>) =>
    validateNimbusConfig(withApi(family(extra), { default: "request" }));

  test("validates as a lowercase name, only on query URLs", () => {
    assert.doesNotThrow(() =>
      check({ versionUrl: { in: "query", param: "api_version" } }),
    );
    assert.throws(
      () => check({ versionUrl: { in: "query", param: "Version" } }),
      /"api\[\]\.versionUrl\.param" must start with a lowercase letter/,
    );
    // A path URL has no parameter to name.
    assert.throws(
      () => check({ versionUrl: { in: "path", param: "v" } }),
      /Unrecognized key: "param"/,
    );
    assert.throws(
      () => check({ versionUrl: { in: "header" } }),
      /"api\[\]\.versionUrl" must be \{ in: "path" \} or \{ in: "query", param\?: string \}/,
    );
  });

  test("0.17's versionMode names its replacement", () => {
    assert.throws(
      () => check({ versionMode: "query" }),
      /sets versionMode, which is now versionUrl\. Replace versionMode: "query" with versionUrl: \{ in: "query" \}/,
    );
  });
});
