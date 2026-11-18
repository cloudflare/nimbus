// `x-nimbus-route`: an operation's slug, or a tag's segment, read from the spec.
// Config overrides win over it, it wins over derivation, and it is ignored (with
// one warning) when the API sets no `routes`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { RoutePolicy } from "../src/_internal/api/route-policy.js";
import { parseOpenApi } from "../src/_internal/api/parse.js";
import { buildApiModel, getApiPageSlugs, getApiRouteProvenance } from "../src/api/index.js";

const V2: RoutePolicy = { convention: "resource-action-v2", sections: "hierarchical" };
const OK = { responses: { "200": { description: "ok" } } };

type PathItem = Record<string, unknown>;

function spec(paths: Record<string, PathItem>, extra: Record<string, unknown> = {}) {
  return { openapi: "3.0.0", info: { title: "T", version: "1.0.0" }, paths, ...extra };
}

let n = 0;
async function routed(
  paths: Record<string, PathItem>,
  routes: RoutePolicy | undefined,
  extra: Record<string, unknown> = {},
  requireOperationId = false,
) {
  const model = await buildApiModel({
    collection: `rx-${n++}`,
    spec: spec(paths, extra),
    routes,
    ...(requireOperationId ? { requireOperationId: true } : {}),
  });
  return {
    slugs: new Map(getApiPageSlugs(model).map(({ coordinate, slug }) => [coordinate, slug])),
    provenance: getApiRouteProvenance(model),
  };
}

async function diagnostics(paths: Record<string, PathItem>, routes: RoutePolicy | undefined, extra = {}) {
  return (await parseOpenApi({ collection: `rx-${n++}`, spec: JSON.stringify(spec(paths, extra)), routes })).diagnostics;
}

describe("x-nimbus-route on operations", () => {
  const paths = {
    "/zones/{zone_id}/dns_records": {
      get: { operationId: "listRecords", "x-nimbus-route": "dns/records/list", ...OK },
      post: { operationId: "createRecord", ...OK },
    },
  };

  test("sets the slug, with provenance extension", async () => {
    const { slugs, provenance } = await routed(paths, V2);
    assert.equal(slugs.get("listRecords"), "dns/records/list");
    assert.equal(provenance.get("listRecords"), "extension");
    // An operation without one still derives (here, falls back to its coordinate).
    assert.notEqual(provenance.get("createRecord"), "extension");
  });

  test("loses to routes.operations", async () => {
    const { slugs, provenance } = await routed(paths, { ...V2, operations: { listRecords: "records/all" } });
    assert.equal(slugs.get("listRecords"), "records/all");
    assert.equal(provenance.get("listRecords"), "override");
  });

  test("wins over derivation", async () => {
    const { slugs, provenance } = await routed(
      { "/pets": { get: { operationId: "listPets", "x-nimbus-route": "animals/list", ...OK } } },
      V2,
    );
    assert.equal(slugs.get("listPets"), "animals/list");
    assert.equal(provenance.get("listPets"), "extension");
  });

  test("routes an operation without an operationId", async () => {
    const p = { "/pets": { get: { "x-nimbus-route": "animals/list", ...OK } } };
    const { slugs } = await routed(p, V2);
    assert.ok([...slugs.values()].includes("animals/list"));
  });

  test("requireOperationId still rejects an operation without one", async () => {
    const p = { "/pets": { get: { "x-nimbus-route": "animals/list", ...OK } } };
    await assert.rejects(() => routed(p, V2, {}, true), /operationId/);
  });

  for (const [value, pattern] of [
    ["Bad Slug", /not lowercase kebab-case/],
    ["/leading", /leading or trailing/],
    ["schemas/list", /reserved route/],
    [3, /must be a string slug/],
  ] as const) {
    test(`rejects ${JSON.stringify(value)}`, async () => {
      const p = { "/pets": { get: { operationId: "listPets", "x-nimbus-route": value, ...OK } } };
      await assert.rejects(() => routed(p, V2), (err: Error) => {
        assert.match(err.message, pattern);
        return true;
      });
    });
  }

  test("two operations on one slug fail naming the extension", async () => {
    const p = {
      "/a": { get: { operationId: "a", "x-nimbus-route": "same/slug", ...OK } },
      "/b": { get: { operationId: "b", "x-nimbus-route": "same/slug", ...OK } },
    };
    await assert.rejects(() => routed(p, V2), /x-nimbus-route/);
  });
});

describe("x-nimbus-route without routes", () => {
  test("changes no URL and warns once", async () => {
    const p = {
      "/pets": { get: { operationId: "listPets", tags: ["Pets"], "x-nimbus-route": "animals/list", ...OK } },
      "/cats": { get: { operationId: "listCats", "x-nimbus-route": "cats/list", ...OK } },
    };
    const extra = { tags: [{ name: "Pets", "x-nimbus-route": "animals" }] };
    const { slugs } = await routed(p, undefined, extra);
    assert.equal(slugs.get("listPets"), "Pets/listPets");
    assert.equal(slugs.get("listCats"), "listCats");
    const warned = (await diagnostics(p, undefined, extra)).filter((d) => /x-nimbus-route is read only/.test(d.message));
    assert.equal(warned.length, 1);
  });
});

describe("x-nimbus-route on tags", () => {
  const p = {
    "/pets": { get: { operationId: "listPets", tags: ["Pets"], ...OK } },
    "/cats": { get: { operationId: "listCats", tags: ["Cats"], ...OK } },
  };
  const extra = {
    tags: [
      { name: "Pets", "x-nimbus-route": "animals" },
      { name: "Cats", "x-tagParent": "Pets", parent: "Pets" },
    ],
  };

  test("sets the segment under hierarchical sections", async () => {
    const { slugs } = await routed(p, V2, extra);
    assert.equal(slugs.get("tags.Pets"), "animals");
  });

  test("sets the segment under flat sections", async () => {
    const { slugs } = await routed(p, { convention: "resource-action-v2" }, extra);
    assert.equal(slugs.get("tags.Pets"), "tags/animals");
  });

  test("loses to routes.tagSegments", async () => {
    const { slugs } = await routed(p, { ...V2, tagSegments: { Pets: "beasts" } }, extra);
    assert.equal(slugs.get("tags.Pets"), "beasts");
  });

  test("rejects a segment with a slash", async () => {
    await assert.rejects(
      () => routed(p, V2, { tags: [{ name: "Pets", "x-nimbus-route": "a/b" }] }),
      /one path segment/,
    );
  });

  test("is ignored with a warning under resource-action-v1", async () => {
    const { slugs } = await routed(p, { convention: "resource-action-v1" }, extra);
    assert.equal(slugs.get("tags.Pets"), "tags/Pets");
    const warned = (await diagnostics(p, { convention: "resource-action-v1" }, extra)).filter((d) =>
      /needs "resource-action-v2"/.test(d.message),
    );
    assert.equal(warned.length, 1);
  });
});
