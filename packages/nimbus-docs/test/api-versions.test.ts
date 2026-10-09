// API version families. Pins the three strings a version resolves to
// (namespace / versionKey / mountPath), the nested-URL contract, the M1
// invariant that coordinates never carry the version (so pages link across
// versions), and the coordinate-identity alternates table (canonical = default,
// hidden excluded).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  resolveApiFamily,
  resolveApiVersion,
  apiPageRoute,
  apiPageSlug,
} from "../src/_internal/api/resolve-versions.js";
import { buildApiVersionAlternates } from "../src/_internal/api/api-alternates.js";
import {
  buildApiModel,
  clearApiModelCache,
  getApiPageProps,
  getApiPageSlugs,
} from "../src/api/index.js";
import type { ApiSpec } from "../src/types.js";

const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/api/", import.meta.url));
function fixtureText(rel: string): string {
  return readFileSync(`${FIXTURE_ROOT}${rel}`, "utf8");
}

describe("apiPageRoute (loader store-id ↔ route param, single source)", () => {
  const def = { isDefault: true, version: "v2" };
  const nonDef = { isDefault: false, version: "v1" };

  test("default root → id `index`, param undefined (the bare mount)", () => {
    assert.deepEqual(apiPageRoute(def, ""), {
      storeId: "index",
      param: undefined,
    });
  });

  test("non-default root → id/param = the version id", () => {
    assert.deepEqual(apiPageRoute(nonDef, ""), { storeId: "v1", param: "v1" });
  });

  test("default non-root → the slug verbatim, id === param", () => {
    assert.deepEqual(apiPageRoute(def, "charges/create"), {
      storeId: "charges/create",
      param: "charges/create",
    });
  });

  test("non-default non-root → version-prefixed, id === param", () => {
    assert.deepEqual(apiPageRoute(nonDef, "charges/create"), {
      storeId: "v1/charges/create",
      param: "v1/charges/create",
    });
  });

  test("apiPageSlug inverts the store id, so pageUrl never doubles a version", () => {
    for (const target of [def, nonDef]) {
      for (const slug of ["", "a", "a/b", "v1", "v1/x"]) {
        assert.equal(
          apiPageSlug(target, apiPageRoute(target, slug).storeId),
          slug,
        );
      }
    }
  });

  test("store id and route param never diverge (they must address one page)", () => {
    for (const target of [def, nonDef]) {
      for (const slug of ["", "a", "a/b", "schemas/X"]) {
        const { storeId, param } = apiPageRoute(target, slug);
        // The only sanctioned divergence is the default root, where the param
        // is `undefined` (Astro's index route) while the id is `index`.
        if (target.isDefault && slug === "") {
          assert.equal(param, undefined);
          assert.equal(storeId, "index");
        } else {
          assert.equal(storeId, param);
        }
      }
    }
  });
});

describe("resolveApiFamily", () => {
  test("unversioned collection resolves byte-identical to the pre-versioning shape", () => {
    const [target] = resolveApiFamily({ collection: "api", spec: "openapi.yaml" });
    assert.equal(target!.family, "api");
    assert.equal(target!.version, null);
    assert.equal(target!.isDefault, true);
    assert.equal(target!.namespace, "api");
    assert.equal(target!.versionKey, "api");
    assert.equal(target!.mountPath, "/api");
  });

  test("versioned family: default owns the bare mount, others nest", () => {
    const targets = resolveApiFamily({
      collection: "core",
      versions: [
        { version: "v4", spec: "v4.yaml", default: true },
        { version: "v3", spec: "v3.yaml", status: "deprecated" },
        { version: "v2", spec: "v2.yaml", hidden: true },
      ],
    });
    const byVersion = Object.fromEntries(targets.map((t) => [t.version, t]));

    assert.equal(byVersion.v4!.isDefault, true);
    assert.equal(byVersion.v4!.mountPath, "/core");
    assert.equal(byVersion.v4!.versionKey, "core@v4");

    assert.equal(byVersion.v3!.isDefault, false);
    assert.equal(byVersion.v3!.mountPath, "/core/v3");
    assert.equal(byVersion.v3!.versionKey, "core@v3");
    assert.equal(byVersion.v3!.status, "deprecated");

    assert.equal(byVersion.v2!.mountPath, "/core/v2");
    assert.equal(byVersion.v2!.hidden, true);
  });

  test("M1: every version shares the family namespace (coordinates never carry the version)", () => {
    const targets = resolveApiFamily({
      collection: "core",
      versions: [
        { version: "v2", spec: "v2.yaml", default: true },
        { version: "v1", spec: "v1.yaml" },
      ],
    });
    for (const t of targets) assert.equal(t.namespace, "core");
  });

  test("first entry is the default when none is flagged", () => {
    const targets = resolveApiFamily({
      collection: "core",
      versions: [
        { version: "v2", spec: "v2.yaml" },
        { version: "v1", spec: "v1.yaml" },
      ],
    });
    assert.equal(targets.find((t) => t.isDefault)!.version, "v2");
  });
});

describe("buildApiVersionAlternates — path-derived fallbacks (missing operationId)", () => {
  const fallbackFamily = (renameParam: boolean): Record<string, unknown> => ({
    openapi: "3.0.0",
    info: { title: "Fallbacks", version: "1.0.0" },
    paths: {
      "/widgets/{id}": {
        get: {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "ok" } },
        },
      },
      [renameParam ? "/things/{key}" : "/things/{id}"]: {
        get: {
          parameters: [
            { name: renameParam ? "key" : "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });

  const api: ApiSpec[] = [
    {
      collection: "fb",
      versions: [
        { version: "v2", spec: fallbackFamily(false), default: true },
        { version: "v1", spec: fallbackFamily(true), status: "deprecated" },
      ],
    },
  ];

  test("identical fallbacks link across versions (canonical → default)", async () => {
    clearApiModelCache("fb");
    const table = await buildApiVersionAlternates(api, FIXTURE_ROOT);
    const v1 = table["fb@v1:get/widgets/id"];
    assert.ok(v1, "the shared-path fallback has a cross-version record");
    assert.equal(v1!.canonical!.version, "v2", "v1 fallback canonicalizes to the default version");
    assert.ok(
      v1!.alternates.some((a) => a.version === "v2"),
      "and lists the v2 sibling as an alternate — the two are linked",
    );
  });

  test("a path-parameter rename keeps the link through the shape fallback", async () => {
    // The coordinates diverge (path-derived ids keep parameter names), but
    // the wire shape is parameter-name-blind, so the two pages pair up.
    clearApiModelCache("fb");
    const table = await buildApiVersionAlternates(api, FIXTURE_ROOT);
    const v2 = table["fb@v2:get/things/id"];
    const v1 = table["fb@v1:get/things/key"];
    assert.ok(v2 && v1, "both renamed pages exist with their own coordinates");
    assert.ok(
      v2!.alternates.some((a) => a.version === "v1"),
      "v2 lists the renamed v1 sibling",
    );
    assert.equal(v1!.canonical!.version, "v2", "v1 canonicalizes to the default");
    assert.equal(
      table["fb@v1:get/things/id"],
      undefined,
      "v1 never minted the v2 coordinate — pages keep their own identities",
    );
  });
});

describe("resolveApiVersion", () => {
  const api: ApiSpec[] = [
    {
      collection: "core",
      versions: [
        { version: "v2", spec: "v2.yaml", default: true },
        { version: "v1", spec: "v1.yaml" },
      ],
    },
  ];

  test("omitting the version selects the default", () => {
    assert.equal(resolveApiVersion(api, "core")!.version, "v2");
    assert.equal(resolveApiVersion(api, "core", null)!.version, "v2");
  });

  test("a named version selects that version", () => {
    assert.equal(resolveApiVersion(api, "core", "v1")!.mountPath, "/core/v1");
  });

  test("unknown collection or version resolves to undefined", () => {
    assert.equal(resolveApiVersion(api, "nope"), undefined);
    assert.equal(resolveApiVersion(api, "core", "v9"), undefined);
  });
});

describe("mountPath drives nested hrefs without moving coordinates", () => {
  const spec = fixtureText("smallco.yaml");

  test("default mount and a nested version mount produce disjoint, correctly-nested hrefs", async () => {
    clearApiModelCache("core");
    const def = await buildApiModel({ collection: "core", spec, mountPath: "/core" });
    const v1 = await buildApiModel({
      collection: "core",
      spec,
      mountPath: "/core/v1",
    });

    assert.equal(getApiPageProps(def, "create").href, "/core/charges/create/");
    assert.equal(getApiPageProps(v1, "create").href, "/core/v1/charges/create/");
    // Root nests too.
    assert.equal(getApiPageProps(def, "core").href, "/core/");
    assert.equal(getApiPageProps(v1, "core").href, "/core/v1/");
  });

  test("coordinates are byte-identical across mounts (M1 — enables cross-version linking)", async () => {
    clearApiModelCache("core");
    const def = await buildApiModel({ collection: "core", spec, mountPath: "/core" });
    const v1 = await buildApiModel({
      collection: "core",
      spec,
      mountPath: "/core/v1",
    });
    const coords = (m: Awaited<ReturnType<typeof buildApiModel>>) =>
      getApiPageSlugs(m)
        .map((p) => p.coordinate)
        .sort();
    assert.deepEqual(coords(def), coords(v1));
  });
});

describe("buildApiVersionAlternates — coordinate-identity axis", () => {
  // Both versions render the same fixture, so every coordinate exists in both
  // and forms a two-member class. v2 is the default (canonical target).
  const api: ApiSpec[] = [
    {
      collection: "core",
      versions: [
        { version: "v2", spec: "smallco.yaml", default: true },
        { version: "v1", spec: "smallco.yaml", status: "deprecated" },
      ],
    },
  ];

  test("keys carry the version key; canonical points at the default", async () => {
    clearApiModelCache("core");
    const table = await buildApiVersionAlternates(api, FIXTURE_ROOT);

    const v1Create = table["core@v1:create"];
    assert.ok(v1Create, "expected a record for the v1 create page");
    assert.equal(v1Create!.self.version, "v1");
    assert.equal(v1Create!.self.url, "/core/v1/charges/create/");
    // Canonical is the default (v2) sibling.
    assert.equal(v1Create!.canonical!.version, "v2");
    assert.equal(v1Create!.canonical!.url, "/core/charges/create/");

    // The default page is itself canonical → no canonical override.
    const v2Create = table["core@v2:create"];
    assert.ok(v2Create);
    assert.equal(v2Create!.canonical, null);
    assert.equal(
      v2Create!.alternates.some((a) => a.version === "v1"),
      true,
    );
  });

  test("M1: the root page links across versions (root coordinate is shared)", async () => {
    clearApiModelCache("core");
    const table = await buildApiVersionAlternates(api, FIXTURE_ROOT);
    const v1Root = table["core@v1:core"];
    assert.ok(v1Root, "root page must have a cross-version record");
    assert.equal(v1Root!.canonical!.url, "/core/");
  });

  test("hidden versions are excluded from other pages' alternates but keep their own record", async () => {
    const withHidden: ApiSpec[] = [
      {
        collection: "core",
        versions: [
          { version: "v2", spec: "smallco.yaml", default: true },
          { version: "v1", spec: "smallco.yaml" },
          { version: "v0", spec: "smallco.yaml", hidden: true },
        ],
      },
    ];
    clearApiModelCache("core");
    const table = await buildApiVersionAlternates(withHidden, FIXTURE_ROOT);

    // v2's alternates must not advertise the hidden v0.
    const v2Create = table["core@v2:create"];
    assert.equal(
      v2Create!.alternates.some((a) => a.version === "v0"),
      false,
    );
    // But v0 is still reachable — it has its own record + canonical to default.
    const v0Create = table["core@v0:create"];
    assert.ok(v0Create);
    assert.equal(v0Create!.canonical!.version, "v2");
  });

  test("an unversioned or single-version family produces no alternates", async () => {
    assert.deepEqual(
      await buildApiVersionAlternates(
        [{ collection: "api", spec: "smallco.yaml" }],
        FIXTURE_ROOT,
      ),
      {},
    );
    assert.deepEqual(
      await buildApiVersionAlternates(
        [{ collection: "core", versions: [{ version: "v1", spec: "smallco.yaml" }] }],
        FIXTURE_ROOT,
      ),
      {},
    );
  });
});

describe("buildApiVersionAlternates — method-and-path fallback for renamed operationIds", () => {
  type Op = { id?: string; method?: string; path: string };
  const spec = (ops: Op[]): Record<string, unknown> => {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const op of ops) {
      const method = op.method ?? "get";
      const params = [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
        name: m[1],
        in: "path",
        required: true,
        schema: { type: "string" },
      }));
      paths[op.path] = {
        ...(paths[op.path] ?? {}),
        [method]: {
          ...(op.id ? { operationId: op.id } : {}),
          ...(params.length ? { parameters: params } : {}),
          responses: { "200": { description: "ok" } },
        },
      };
    }
    return {
      openapi: "3.0.0",
      info: { title: "Match", version: "1.0.0" },
      paths,
    };
  };
  const family = (
    collection: string,
    versions: Array<[string, Op[]]>,
    defaultVersion = versions[0]![0],
  ): ApiSpec[] => [
    {
      collection,
      versions: versions.map(([version, ops]) => ({
        version,
        spec: spec(ops),
        ...(version === defaultVersion ? { default: true } : {}),
      })),
    },
  ];
  /** The class a page belongs to, as a sorted member list. */
  const classOf = (
    table: Awaited<ReturnType<typeof buildApiVersionAlternates>>,
    key: string,
  ) => {
    const record = table[key]!;
    return [record.self, ...record.alternates]
      .map((ref) => `${ref.version}:${ref.slug}`)
      .sort();
  };

  test("1: a renamed operationId with the same method and path matches across two versions", async () => {
    const table = await buildApiVersionAlternates(
      family("m1", [
        ["v2", [{ id: "newId", path: "/zones" }]],
        ["v1", [{ id: "oldId", path: "/zones" }]],
      ]),
      FIXTURE_ROOT,
    );
    assert.deepEqual(classOf(table, "m1@v1:oldId"), ["v1:oldId", "v2:newId"]);
    assert.equal(table["m1@v1:oldId"]!.canonical!.version, "v2");
  });

  test("2: v1:oldId, v2:newId, v3:newId (same shape) end in one class of three", async () => {
    const table = await buildApiVersionAlternates(
      family("m2", [
        ["v3", [{ id: "newId", path: "/zones/{zone_id}" }]],
        ["v2", [{ id: "newId", path: "/zones/{zone_id}" }]],
        ["v1", [{ id: "oldId", path: "/zones/{zone_id}" }]],
      ]),
      FIXTURE_ROOT,
    );
    assert.deepEqual(classOf(table, "m2@v1:oldId"), [
      "v1:oldId",
      "v2:newId",
      "v3:newId",
    ]);
  });

  test("3: a renamed path parameter matches", async () => {
    const table = await buildApiVersionAlternates(
      family("m3", [
        ["v2", [{ id: "newId", path: "/zones/{zone_identifier}" }]],
        ["v1", [{ id: "oldId", path: "/zones/{zone_id}" }]],
      ]),
      FIXTURE_ROOT,
    );
    assert.deepEqual(classOf(table, "m3@v1:oldId"), ["v1:oldId", "v2:newId"]);
  });

  test("4+5: two eligible operations with one shape on one side stay unmatched", async () => {
    const table = await buildApiVersionAlternates(
      family("m4", [
        ["v2", [{ id: "c", path: "/items/{x}" }]],
        [
          "v1",
          [
            { id: "a", path: "/items/{id}" },
            { id: "b", method: "get", path: "/items/{key}" },
          ],
        ],
      ]),
      FIXTURE_ROOT,
    );
    for (const key of ["m4@v1:a", "m4@v1:b", "m4@v2:c"]) {
      assert.equal(table[key]!.alternates.length, 0, `${key} stays unmatched`);
    }
    assert.equal(table["m4@v1:a"]!.canonical, null);
  });

  test("6: competing candidates across pairs merge nothing (order independence)", async () => {
    const table = await buildApiVersionAlternates(
      family("m6", [
        [
          "v1",
          [
            { id: "a", path: "/x" },
            { id: "b", path: "/y" },
          ],
        ],
        ["v2", [{ id: "c", path: "/x" }]],
        ["v3", [{ id: "c", path: "/y" }]],
      ]),
      FIXTURE_ROOT,
    );
    assert.deepEqual(classOf(table, "m6@v1:a"), ["v1:a"]);
    assert.deepEqual(classOf(table, "m6@v1:b"), ["v1:b"]);
    assert.deepEqual(classOf(table, "m6@v2:c"), ["v2:c", "v3:c"]);
  });

  test("7: an unrelated consistent candidate merges while the conflicting component doesn't", async () => {
    const table = await buildApiVersionAlternates(
      family("m7", [
        [
          "v1",
          [
            { id: "a", path: "/x" },
            { id: "b", path: "/y" },
            { id: "d", path: "/z" },
          ],
        ],
        [
          "v2",
          [
            { id: "c", path: "/x" },
            { id: "e", path: "/z" },
          ],
        ],
        [
          "v3",
          [
            { id: "c", path: "/y" },
            { id: "e", path: "/z" },
          ],
        ],
      ]),
      FIXTURE_ROOT,
    );
    assert.deepEqual(classOf(table, "m7@v1:d"), ["v1:d", "v2:e", "v3:e"]);
    assert.deepEqual(classOf(table, "m7@v1:a"), ["v1:a"]);
    assert.deepEqual(classOf(table, "m7@v2:c"), ["v2:c", "v3:c"]);
  });

  test("8: a removed operation still goes to the landing page", async () => {
    const table = await buildApiVersionAlternates(
      family("m8", [
        ["v2", [{ id: "kept", path: "/kept" }]],
        [
          "v1",
          [
            { id: "kept", path: "/kept" },
            { id: "removed", method: "delete", path: "/gone" },
          ],
        ],
      ]),
      FIXTURE_ROOT,
    );
    assert.deepEqual(classOf(table, "m8@v1:removed"), ["v1:removed"]);
    assert.equal(table["m8@v1:removed"]!.canonical, null);
  });

  test("9: an operationId match is never overridden by a shape match", async () => {
    const table = await buildApiVersionAlternates(
      family("m9", [
        [
          "v2",
          [
            { id: "stable", path: "/new-home" },
            { id: "tempting", path: "/old-home" },
          ],
        ],
        ["v1", [{ id: "stable", path: "/old-home" }]],
      ]),
      FIXTURE_ROOT,
    );
    // `stable` spans both versions by id; `tempting` shares v1-stable's old
    // shape but stable's class already has a v1 member, so nothing merges.
    assert.deepEqual(classOf(table, "m9@v1:stable"), ["v1:stable", "v2:stable"]);
    assert.deepEqual(classOf(table, "m9@v2:tempting"), ["v2:tempting"]);
  });

  test("10: class membership is permutation-independent with the default held fixed", async () => {
    const fixtures: Array<[string, Array<[string, Op[]]>]> = [
      ["p2", [
        ["v1", [{ id: "oldId", path: "/zones" }]],
        ["v2", [{ id: "newId", path: "/zones" }]],
        ["v3", [{ id: "newId", path: "/zones" }]],
      ]],
      ["p6", [
        ["v1", [{ id: "a", path: "/x" }, { id: "b", path: "/y" }]],
        ["v2", [{ id: "c", path: "/x" }]],
        ["v3", [{ id: "c", path: "/y" }]],
      ]],
      ["p7", [
        ["v1", [{ id: "a", path: "/x" }, { id: "b", path: "/y" }, { id: "d", path: "/z" }]],
        ["v2", [{ id: "c", path: "/x" }, { id: "e", path: "/z" }]],
        ["v3", [{ id: "c", path: "/y" }, { id: "e", path: "/z" }]],
      ]],
    ];
    const membership = (
      table: Awaited<ReturnType<typeof buildApiVersionAlternates>>,
    ) =>
      JSON.stringify(
        [...new Set(Object.keys(table).map((key) => classOf(table, key).join("|")))].sort(),
      );
    for (const [name, versions] of fixtures) {
      const [head, ...rest] = versions;
      const permutations: Array<Array<[string, Op[]]>> = [
        [head!, ...rest],
        [head!, ...[...rest].reverse()],
      ];
      const results = new Set<string>();
      for (const permutation of permutations) {
        clearApiModelCache(name);
        const table = await buildApiVersionAlternates(
          family(name, permutation, "v1"),
          FIXTURE_ROOT,
        );
        results.add(membership(table));
      }
      assert.equal(results.size, 1, `${name}: membership differs across permutations`);
    }
  });

  test("11: the table for an unversioned collection stays empty", async () => {
    const table = await buildApiVersionAlternates(
      [{ collection: "m11", spec: spec([{ id: "only", path: "/x" }]) }],
      FIXTURE_ROOT,
    );
    assert.deepEqual(table, {});
  });

  test("12: canonical for a shape-matched old-version page points at the default's page", async () => {
    const table = await buildApiVersionAlternates(
      family("m12", [
        ["v2", [{ id: "newId", path: "/widgets/{id}" }]],
        ["v1", [{ id: "oldId", path: "/widgets/{key}" }]],
      ]),
      FIXTURE_ROOT,
    );
    const record = table["m12@v1:oldId"]!;
    assert.equal(record.canonical!.version, "v2");
    assert.equal(record.canonical!.slug, "newId");
    assert.equal(record.canonical!.url, table["m12@v2:newId"]!.self.url);
  });

  test("an id that moves path bridges its old shape into one class", async () => {
    const table = await buildApiVersionAlternates(
      family("bridge", [
        ["v1", [{ id: "a", path: "/x" }]],
        ["v2", [{ id: "b", path: "/x" }]],
        ["v3", [{ id: "b", path: "/y" }]],
      ]),
      FIXTURE_ROOT,
    );
    assert.deepEqual(classOf(table, "bridge@v1:a"), ["v1:a", "v2:b", "v3:b"]);
  });

  test("a long contradictory chain rejects as one component and keeps every exact-id class", async () => {
    // Every candidate links into one chain (a_i–b_i, b_i–c_i, a_i–c_(i+1)),
    // which an unbalanced union-find walks quadratically.
    const n = 300;
    const pad = (i: number) => String(i).padStart(4, "0");
    const ops = (rows: Array<(i: number) => Op>) =>
      Array.from({ length: n }, (_, i) => rows.map((row) => row(i))).flat();
    const table = await buildApiVersionAlternates(
      family("chain", [
        ["v1", ops([(i) => ({ id: `a${pad(i)}`, path: `/x/${pad(i)}` }), (i) => ({ id: `c${pad(i)}`, path: `/z/${pad(i)}` })])],
        ["v2", ops([(i) => ({ id: `a${pad(i)}`, path: `/y/${pad(i)}` }), (i) => ({ id: `b${pad(i)}`, path: `/z/${pad(i)}` })])],
        ["v3", ops([(i) => ({ id: `b${pad(i)}`, path: `/x/${pad(i)}` }), (i) => ({ id: `c${pad(i)}`, path: `/y/${pad(i - 1)}` })])],
      ]),
      FIXTURE_ROOT,
    );
    assert.deepEqual(classOf(table, "chain@v1:a0007"), ["v1:a0007", "v2:a0007"]);
    assert.deepEqual(classOf(table, "chain@v2:b0007"), ["v2:b0007", "v3:b0007"]);
    assert.deepEqual(classOf(table, "chain@v1:c0007"), ["v1:c0007", "v3:c0007"]);
  });
});

describe("operationShape — normalization boundaries", () => {
  test("keeps empty segments and composite placeholder segments distinct", async () => {
    const { operationShape } = await import(
      "../src/_internal/api/coordinates.js"
    );
    assert.equal(operationShape("GET", "/items/details"), "get/items/details");
    assert.notEqual(
      operationShape("GET", "/items//details"),
      operationShape("GET", "/items/details"),
    );
    assert.notEqual(
      operationShape("GET", "/items/"),
      operationShape("GET", "/items"),
    );
    assert.equal(operationShape("GET", "/zones/{a}"), operationShape("get", "/zones/{b}"));
    // A composite segment keeps its text: `{name}.{format}` never pairs
    // with a plain `{id}` segment, and two composites with different names
    // stay unmatched (the picker never guesses).
    assert.notEqual(
      operationShape("GET", "/files/{name}.{format}"),
      operationShape("GET", "/files/{id}"),
    );
    assert.notEqual(
      operationShape("GET", "/files/{name}.{format}"),
      operationShape("GET", "/files/{other}.{fmt}"),
    );
  });
});
