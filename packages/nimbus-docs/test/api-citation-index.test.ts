// The citation-index producer — the coordinate → URL contract the resolver reads.
// Pins URL formation (mount path per D18), the default/versioned key pair, the
// published manifest shape, and remote-manifest ingest with path-only value
// validation + trusted origin. If this goes red, the citation contract moved.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildCitationIndex, ingestRemoteManifest, type CoordinatesManifest } from "../src/_internal/api/citation-index.ts";
import type { ApiSpec } from "../src/types.ts";

function fixturePath(rel: string): string {
  return fileURLToPath(new URL(`./fixtures/api/${rel}`, import.meta.url));
}

const root = fileURLToPath(new URL(".", import.meta.url));

describe("buildCitationIndex: unversioned collection", () => {
  const api: ApiSpec[] = [{ collection: "smallco", spec: fixturePath("smallco.yaml"), schemaPages: true }];

  test("keys pages under collection:coordinate with site-absolute /collection URLs", async () => {
    const { index } = await buildCitationIndex(api, root);
    assert.ok(index.size > 0);
    // the root page maps to the bare mount path
    assert.equal(index.get("smallco:smallco"), "/smallco");
    // every value is a site-absolute path under the mount
    for (const [, url] of index) assert.match(url, /^\/smallco(\/.*)?$/);
  });

  test("manifest carries the collection with a null defaultVersion", async () => {
    const { manifest } = await buildCitationIndex(api, root);
    assert.equal(manifest.version, 2);
    assert.equal(manifest.collections.smallco?.defaultVersion, null);
    assert.ok(manifest.collections.smallco!.pages.length > 0);
    assert.equal(manifest.collections.smallco!.versions, undefined);
    assert.deepEqual(read(manifest), (await buildCitationIndex(api, root)).index);
  });

  test("manifest maps are null-prototype (a '__proto__'/'constructor' key can never pollute)", async () => {
    const { manifest } = await buildCitationIndex(api, root);
    assert.equal(Object.getPrototypeOf(manifest.collections), null);
    assert.equal(Object.getPrototypeOf(manifest.collections.smallco!.pages[0]!.entries), null);
  });
});

describe("buildCitationIndex: versioned family (v2 default + v1)", () => {
  const spec = fixturePath("smallco.yaml");
  const api: ApiSpec[] = [
    {
      collection: "svc",
      versions: [
        { version: "v2", default: true, spec },
        { version: "v1", spec },
      ],
    },
  ];

  test("default version is addressable both bare and @-qualified; v1 lives under /svc/v1", async () => {
    const { index, manifest } = await buildCitationIndex(api, root);
    // default (v2): bare key → /svc, and @v2 key → /svc
    assert.equal(index.get("svc:svc"), "/svc");
    assert.equal(index.get("svc@v2:svc"), "/svc");
    // non-default (v1): only the @v1 key exists, under /svc/v1 — no bare alias
    assert.equal(index.get("svc@v1:svc"), "/svc/v1");
    assert.equal(
      index.get("svc:create.response.200"),
      `${index.get("svc:create")}#response-200`,
    );
    assert.equal(
      index.get("svc@v1:create.response.200"),
      `${index.get("svc@v1:create")}#response-200`,
    );
    assert.equal(manifest.collections.svc?.defaultVersion, "v2");
  });
});

describe("buildCitationIndex: field coordinates resolve to <page>#<anchor>", () => {
  const api: ApiSpec[] = [{ collection: "smallco", spec: fixturePath("smallco.yaml"), schemaPages: true }];

  test("a body field, a parameter, and a schema field each cite their owning page plus a lossless anchor", async () => {
    const { index } = await buildCitationIndex(api, root);
    // The anchor is the coordinate itself when it is already fragment-safe, so
    // the field URL is exactly the owning page's URL plus that fragment.
    assert.equal(index.get("smallco:create.amount"), `${index.get("smallco:create")}#create.amount`);
    assert.equal(index.get("smallco:list.query.limit"), `${index.get("smallco:list")}#list.query.limit`);
    assert.equal(index.get("smallco:Charge.amount"), `${index.get("smallco:Charge")}#Charge.amount`);
  });

  test("a colon-bearing field name yields a fragment-safe (sanitized + disambiguated) anchor", async () => {
    const { index } = await buildCitationIndex(api, root);
    const url = index.get("smallco:search.static:wan");
    assert.ok(url, "the hostile body property is citeable");
    const [pageUrl, fragment] = url!.split("#");
    assert.equal(pageUrl, index.get("smallco:search"));
    // ':' is not fragment-safe, so it is rewritten and a lossless base32 suffix
    // appended for injectivity.
    assert.match(fragment, /^search\.static-wan--[a-z2-7]+$/);
    assert.ok(!fragment.includes(":"));
  });

  test("field coordinates are published in the manifest alongside pages", async () => {
    const { manifest } = await buildCitationIndex(api, root);
    assert.match(read(manifest).get("smallco:create.amount")!, /#create\.amount$/);
  });
});

describe("buildCitationIndex: response coordinates resolve to rendered anchors", () => {
  const api: ApiSpec[] = [{ collection: "smallco", spec: fixturePath("smallco.yaml"), schemaPages: true }];

  test("bare responses are addressable in the index and manifest", async () => {
    const { index, manifest } = await buildCitationIndex(api, root);
    assert.equal(
      index.get("smallco:create.response.200"),
      `${index.get("smallco:create")}#response-200`,
    );
    assert.equal(
      read(manifest).get("smallco:create.response.200"),
      `${index.get("smallco:create")}#response-200`,
    );
  });

  test("deviant response statuses use the exact rendered anchor", async () => {
    const { index } = await buildCitationIndex(
      [{ collection: "dev", spec: fixturePath("deviant.yaml"), schemaPages: true }],
      root,
    );
    assert.equal(
      index.get("dev:listWidgets.response.4xx"),
      `${index.get("dev:listWidgets")}#response-4xx`,
    );
  });

  test("punctuation in a response status is sanitized losslessly", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "Odd status", version: "1.0.0" },
      paths: {
        "/odd": {
          get: {
            operationId: "oddStatus",
            responses: { "2:00": { description: "ok" } },
          },
        },
      },
    };
    const { index } = await buildCitationIndex(
      [{ collection: "odd", spec, schemaPages: true }],
      root,
    );
    const url = index.get("odd:oddStatus.response.2:00");
    assert.ok(url);
    assert.match(url, /#response-2-00--[a-z2-7]+$/);
    assert.ok(!url.split("#")[1]!.includes(":"));
  });
});


function read(manifest: CoordinatesManifest) {
  const index = new Map<string, string>();
  for (const name of Object.keys(manifest.collections)) {
    assert.deepEqual(ingestRemoteManifest(index, name, JSON.parse(JSON.stringify(manifest))), []);
  }
  return index;
}

describe("prepared API citations: historical authored lookup without published history", () => {
  test("cached summaries avoid parsing and preserve old fields and responses", async () => {
    const reads = new Map<string, number>();
    const versions = ["v3", "v2", "v1"];
    const preparedVersions = new Map(
      versions.map((version) => [
        `svc@${version}`,
        {
          read() {
            reads.set(version, (reads.get(version) ?? 0) + 1);
            return {
              targets: [
                { coordinate: "svc", slug: "" },
                { coordinate: `operation-${version}`, slug: `slug-${version}` },
                {
                  coordinate: `operation-${version}.field`,
                  slug: `slug-${version}`,
                  anchor: "field",
                },
                {
                  coordinate: `operation-${version}.response.200`,
                  slug: `slug-${version}`,
                  anchor: "response-200",
                },
              ],
              unpublished: { UnpublishedSchema: "UnpublishedSchema" },
            };
          },
        },
      ]),
    );
    const { index, manifest, unpublished } = await buildCitationIndex(
      [
        {
          collection: "svc",
          versionMode: "query",
          versions: versions.map((version, i) => ({
            version,
            spec: "/does/not/exist.json",
            default: i === 0,
          })),
        },
      ],
      root,
      { preparedVersions },
    );
    assert.equal(reads.get("v3"), 1);
    assert.equal(reads.has("v2"), false);
    assert.equal(
      index.get("svc@v2:operation-v2.field"),
      "/svc/slug-v2?version=v2#field",
    );
    assert.equal(
      index.get("svc@v2:operation-v2.response.200"),
      "/svc/slug-v2?version=v2#response-200",
    );
    assert.equal(
      unpublished.get("svc@v2:UnpublishedSchema"),
      "UnpublishedSchema",
    );
    assert.equal(
      reads.get("v2"),
      1,
      "one summary read serves all fields and diagnostics in this version",
    );
    assert.equal(index.has("svc@v2:operation-v2"), true);
    assert.equal(
      index.get("svc@v1:operation-v1"),
      "/svc/slug-v1?version=v1",
    );
    assert.equal(
      index.get("svc@v2:operation-v2"),
      "/svc/slug-v2?version=v2",
    );
    assert.equal(reads.get("v2"), 2, "cache retains one historical version");
    assert.equal(index.get("svc@missing:operation-v2"), undefined);
    assert.equal(index.get("svc@v2:missing"), undefined);
    assert.deepEqual(Object.keys(manifest.collections.svc!.versions!), ["v3"]);
    assert.ok(
      [...index.keys()].every(
        (key) => !key.includes("@v1:") && !key.includes("@v2:"),
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(Object.fromEntries(index)),
      /operation-v[12]/,
      "virtual module contains published default only even after authored reads",
    );
  });
});
