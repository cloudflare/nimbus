// `routes.sections: "hierarchical"` serves a tag page at its hierarchy's path
// instead of `tags/<segment>`, and `routes.tagSegments` renames one tag's
// segment. Everything here is model-level; the real build and the mixed
// family live in api-route-policy-v2.test.ts beside the other tag-URL surfaces.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { hierarchicalTagRouteSegment } from "../src/_internal/api/coordinates.js";
import type { RoutePolicy } from "../src/_internal/api/route-policy.js";
import { buildApiModel, getApiPageSlugs } from "../src/api/index.js";
import { validateNimbusConfig } from "../src/_internal/validate.js";

const V2: RoutePolicy = { convention: "resource-action-v2" };
const TREE: RoutePolicy = { ...V2, sections: "hierarchical" };
const OK = { responses: { "200": { description: "ok" } } };

type Tag = { name: string; parent?: string };
async function slugsOf(
  collection: string,
  tags: Tag[],
  routes: RoutePolicy | undefined,
  extra: Record<string, unknown> = {},
): Promise<Map<string, string>> {
  const paths = Object.fromEntries(
    tags.map((tag, i) => [`/p${i}`, { get: { operationId: `op${i}`, tags: [tag.name], ...OK } }]),
  );
  const spec = { openapi: "3.0.0", info: { title: "T", version: "1.0.0" }, tags, paths, ...extra };
  const model = await buildApiModel({ collection, spec, routes });
  return new Map(getApiPageSlugs(model).map(({ coordinate, slug }) => [coordinate, slug]));
}

const ZONES: Tag[] = [
  { name: "zones" },
  { name: "zones-dns", parent: "zones" },
  { name: "zones-dns-records", parent: "zones-dns" },
];

describe("hierarchicalTagRouteSegment", () => {
  test("drops the parent's projected name as a prefix, on projected names", () => {
    assert.equal(hierarchicalTagRouteSegment("zones-dns", "zones"), "dns");
    assert.equal(hierarchicalTagRouteSegment("zones-dns-records", "zones-dns"), "records");
    assert.equal(hierarchicalTagRouteSegment("Zero Trust Devices", "Zero Trust"), "devices");
    assert.equal(hierarchicalTagRouteSegment("records", "zones-dns"), "records");
    assert.equal(hierarchicalTagRouteSegment("zones"), "zones");
  });
});

describe("flat sections are unchanged", () => {
  test("a prefixed child keeps its full segment, with or without sections: flat", async () => {
    for (const routes of [V2, { ...V2, sections: "flat" as const }]) {
      const slugs = await slugsOf("flat", ZONES, routes);
      assert.equal(slugs.get("tags.zones-dns"), "tags/zones-dns");
      assert.equal(slugs.get("tags.zones-dns-records"), "tags/zones-dns-records");
    }
  });

  test("tagSegments renames one tag under flat", async () => {
    const slugs = await slugsOf("flat-seg", [{ name: "User Management" }], {
      ...V2,
      tagSegments: { "User Management": "people" },
    });
    assert.equal(slugs.get("tags.User Management"), "tags/people");
  });
});

describe("hierarchical sections", () => {
  test("a tag is served at its ancestors' segments then its own", async () => {
    const slugs = await slugsOf("tree", ZONES, TREE);
    assert.equal(slugs.get("tags.zones"), "zones");
    assert.equal(slugs.get("tags.zones-dns"), "zones/dns");
    assert.equal(slugs.get("tags.zones-dns-records"), "zones/dns/records");
    const flat = await slugsOf("tree-vs-flat", ZONES, V2);
    const operations = (m: Map<string, string>) => [...m].filter(([c]) => c.startsWith("op"));
    assert.deepEqual(operations(slugs), operations(flat), "operation slugs are untouched");
  });

  test("a child without the parent prefix and a spaced label both nest", async () => {
    const slugs = await slugsOf(
      "tree-plain",
      [{ name: "zones" }, { name: "zones-dns", parent: "zones" }, { name: "records", parent: "zones-dns" }],
      TREE,
    );
    assert.equal(slugs.get("tags.records"), "zones/dns/records");
    const spaced = await slugsOf(
      "tree-spaced",
      [{ name: "Zero Trust" }, { name: "Zero Trust Devices", parent: "Zero Trust" }],
      TREE,
    );
    assert.equal(slugs.get("tags.zones"), "zones");
    assert.equal(spaced.get("tags.Zero Trust Devices"), "zero-trust/devices");
  });

  test("a nav-only x-tagGroups category is transparent", async () => {
    const slugs = await slugsOf("tree-group", [{ name: "payments" }, { name: "cards" }], TREE, {
      "x-tagGroups": [{ name: "Billing", tags: ["payments", "cards"] }],
    });
    assert.equal(slugs.get("tags.payments"), "payments");
    assert.equal(slugs.get("tags.cards"), "cards");
    assert.equal(slugs.has("tags.Billing"), false);
    const prefixed = await slugsOf("tree-group-prefix", [{ name: "zero-trust-devices" }], TREE, {
      "x-tagGroups": [{ name: "Zero Trust", tags: ["zero-trust-devices"] }],
    });
    assert.equal(prefixed.get("tags.zero-trust-devices"), "zero-trust-devices", "a page-less category is no prefix to strip");
    await assert.rejects(
      () =>
        slugsOf("tree-group-seg", [{ name: "payments" }], { ...TREE, tagSegments: { Billing: "billing" } }, {
          "x-tagGroups": [{ name: "Billing", tags: ["payments"] }],
        }),
      /Tag segment for "Billing" does not match any tag with a page/,
    );
  });

  test("tagSegments renames a tag and its subtree; a reserved top-level tag needs it", async () => {
    const TAGS: Tag[] = [{ name: "tags" }, { name: "tags-keys", parent: "tags" }];
    const slugs = await slugsOf("tree-tagging", TAGS, { ...TREE, tagSegments: { tags: "tagging" } });
    assert.equal(slugs.get("tags.tags"), "tagging");
    assert.equal(slugs.get("tags.tags-keys"), "tagging/keys");
    await assert.rejects(
      () => slugsOf("tree-reserved", TAGS, TREE),
      /Tag "tags" resolves to route "tags", whose top-level segment "tags" is held for Nimbus[\s\S]*routes\.tagSegments/,
    );
  });

  test("two pages on one path fail naming both", async () => {
    await assert.rejects(
      () => slugsOf("tree-dup", [{ name: "zones" }, { name: "zones-dns", parent: "zones" }, { name: "dns", parent: "zones" }], TREE),
      /"tags\.zones-dns"[\s\S]*"tags\.dns"[\s\S]*both map to the\s+route slug "zones\/dns"[\s\S]*give tag "dns" another segment in `routes\.tagSegments`/,
    );
    const spec = {
      openapi: "3.0.0",
      info: { title: "T", version: "1.0.0" },
      tags: [{ name: "zones" }, { name: "zones-dns", parent: "zones" }],
      paths: { "/zones": { get: { operationId: "listZones", tags: ["zones"], ...OK } } },
    };
    await assert.rejects(
      () => buildApiModel({ collection: "tree-op", spec, routes: { ...TREE, operations: { listZones: "zones/dns" } } }),
      /"tags\.zones-dns"[\s\S]*"listZones"[\s\S]*both map to the\s+route slug "zones\/dns"[\s\S]*give tag "zones-dns" another segment in `routes\.tagSegments`/,
    );
  });

  test("an unused tagSegments key is an error", async () => {
    await assert.rejects(
      () => slugsOf("tree-unused", ZONES, { ...TREE, tagSegments: { zone: "z" } }),
      /Tag segment for "zone" does not match any tag with a page/,
    );
  });
});

describe("routes config validation for sections", () => {
  const withRoutes = (routes: unknown) =>
    ({ site: "https://example.com", title: "T", api: [{ collection: "s", spec: "./s.json", routes }] }) as Parameters<
      typeof validateNimbusConfig
    >[0];

  test("hierarchical needs resource-action-v2", () => {
    assert.doesNotThrow(() => validateNimbusConfig(withRoutes({ ...TREE, tagSegments: { tags: "tagging" } })));
    assert.throws(
      () => validateNimbusConfig(withRoutes({ convention: "resource-action-v1", sections: "hierarchical" })),
      /"sections" needs "resource-action-v2"/,
    );
    assert.throws(
      () => validateNimbusConfig(withRoutes({ convention: "resource-action-v1", tagSegments: { a: "b" } })),
      /"tagSegments" needs "resource-action-v2"/,
    );
    assert.throws(() => validateNimbusConfig(withRoutes({ ...V2, sections: "nested" })), /must be "flat" or "hierarchical"/);
  });

  test("a tag segment is one lowercase kebab segment", () => {
    assert.throws(
      () => validateNimbusConfig(withRoutes({ ...V2, tagSegments: { tags: "tag/ging" } })),
      /tag segment for "tags" → "tag\/ging" has a '\/'/,
    );
    assert.throws(
      () => validateNimbusConfig(withRoutes({ ...V2, tagSegments: { tags: "Tagging" } })),
      /tag segment for "tags" → "Tagging" segment 'Tagging' is not lowercase kebab-case/,
    );
  });
});
