// Config validation for API version families. The rules are permanent public
// surface, so each is pinned: spec XOR versions, unique slug-safe ids, one
// default, default-can't-be-hidden, and the reserved version ids that would
// shadow a section URL.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { validateNimbusConfig } from "../src/_internal/validate.js";

function withApi(api: unknown): unknown {
  return { site: "https://example.com", title: "T", api };
}

describe("api version config — accepted", () => {
  test("a single unversioned spec", () => {
    assert.doesNotThrow(() =>
      validateNimbusConfig(withApi([{ collection: "api", spec: "./openapi.yaml" }])),
    );
  });

  test("a version family with an explicit default", () => {
    assert.doesNotThrow(() =>
      validateNimbusConfig(
        withApi([
          {
            collection: "core",
            versions: [
              { version: "v2", spec: "./v2.yaml", default: true },
              { version: "v1", spec: "./v1.yaml", status: "deprecated" },
              { version: "v0", spec: "./v0.yaml", hidden: true },
            ],
          },
        ]),
      ),
    );
  });

  test("a family with no explicit default (first is implied)", () => {
    assert.doesNotThrow(() =>
      validateNimbusConfig(
        withApi([
          {
            collection: "core",
            versions: [
              { version: "v2", spec: "./v2.yaml" },
              { version: "v1", spec: "./v1.yaml" },
            ],
          },
        ]),
      ),
    );
  });
});

describe("api version config — rejected", () => {
  const cases: Array<[string, unknown]> = [
    [
      "both spec and versions",
      [
        {
          collection: "core",
          spec: "./openapi.yaml",
          versions: [{ version: "v1", spec: "./v1.yaml" }],
        },
      ],
    ],
    ["neither spec nor versions", [{ collection: "core" }]],
    ["empty versions array", [{ collection: "core", versions: [] }]],
    [
      "two defaults",
      [
        {
          collection: "core",
          versions: [
            { version: "v2", spec: "./v2.yaml", default: true },
            { version: "v1", spec: "./v1.yaml", default: true },
          ],
        },
      ],
    ],
    [
      "default marked hidden",
      [
        {
          collection: "core",
          versions: [{ version: "v2", spec: "./v2.yaml", default: true, hidden: true }],
        },
      ],
    ],
    [
      "reserved version id",
      [
        {
          collection: "core",
          versions: [
            { version: "v2", spec: "./v2.yaml", default: true },
            { version: "schemas", spec: "./s.yaml" },
          ],
        },
      ],
    ],
    [
      "duplicate version ids",
      [
        {
          collection: "core",
          versions: [
            { version: "v1", spec: "./a.yaml", default: true },
            { version: "v1", spec: "./b.yaml" },
          ],
        },
      ],
    ],
    [
      "version id with illegal characters",
      [
        {
          collection: "core",
          versions: [{ version: "V2.0", spec: "./v2.yaml", default: true }],
        },
      ],
    ],
    [
      // `index` is the DataStore id the default root maps to — a version named
      // `index` would clobber it, so it is reserved alongside schemas/tags/…
      "version id `index` collides with the default root",
      [
        {
          collection: "core",
          versions: [
            { version: "v2", spec: "./v2.yaml", default: true },
            { version: "index", spec: "./i.yaml" },
          ],
        },
      ],
    ],
    [
      "collection named `docs` collides with the built-in content collection",
      [{ collection: "docs", spec: "./openapi.yaml" }],
    ],
    [
      "collection named `partials` collides with the built-in content collection",
      [{ collection: "partials", spec: "./openapi.yaml" }],
    ],
    [
      "collection named `nimbus-api` collides with the published coordinate manifest route",
      [{ collection: "nimbus-api", spec: "./openapi.yaml" }],
    ],
  ];

  for (const [name, api] of cases) {
    test(name, () => {
      assert.throws(() => validateNimbusConfig(withApi(api)));
    });
  }
});

describe("api tryIt.testKey", () => {
  const withKey = (testKey: unknown) => withApi([{ collection: "api", spec: "./openapi.yaml", tryIt: { testKey } }]);

  test("a printable key is accepted", () => {
    assert.doesNotThrow(() => validateNimbusConfig(withKey("test_123")));
  });

  test("an empty key or one with a space is refused", () => {
    assert.throws(() => validateNimbusConfig(withKey("")), /testKey/);
    assert.throws(() => validateNimbusConfig(withKey("test 123")), /testKey/);
  });
});
