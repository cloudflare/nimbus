import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertApiPagesLiveCollection,
  unbundledApiCollections,
} from "../src/_internal/page-assets-config.ts";
import { validateNimbusConfig } from "../src/_internal/validate.ts";

const config = (bundle: unknown, rendering?: unknown) => ({
  site: "https://example.com",
  title: "T",
  api: [
    { collection: "big", spec: "./big.yaml", bundle },
    { collection: "small", spec: "./small.yaml" },
  ],
  ...(rendering === undefined ? {} : { rendering }),
});

test("bundle: false selects only the APIs that set it", () => {
  const parsed = validateNimbusConfig(
    config(false, { collections: { big: "request" } }),
  );
  assert.deepEqual(unbundledApiCollections(parsed), ["big"]);
  assert.deepEqual(
    unbundledApiCollections(
      validateNimbusConfig(config(true, { default: "request" })),
    ),
    [],
  );
});

test("bundle: false on a build-rendered API names the rendering fix", () => {
  assert.throws(
    () => validateNimbusConfig(config(false)),
    /"big" sets bundle: false, which needs it rendered on request\. Add rendering: \{ collections: \{ "big": "request" \} \}/,
  );
  assert.throws(
    () =>
      validateNimbusConfig(
        config(false, { default: "request", collections: { big: "build" } }),
      ),
    /rendering\.collections\.big is "build"\. Set it to "request"/,
  );
  assert.deepEqual(
    unbundledApiCollections(
      validateNimbusConfig(config(false, { default: "request" })),
    ),
    ["big"],
  );
});

test("bundle must be a boolean", () => {
  assert.throws(
    () => validateNimbusConfig(config("no")),
    /"api\[\]\.bundle" must be a boolean/,
  );
});

test("bundle: false needs the apiPages live collection, and the error shows the file to write", () => {
  const files = new Map<string, string>();
  const read = (file: string) => files.get(file);
  assert.doesNotThrow(() =>
    assertApiPagesLiveCollection("/site/src", [], read),
  );
  assert.throws(
    () => assertApiPagesLiveCollection("/site/src", ["big"], read),
    /Create src\/live\.config\.ts:[\s\S]*apiPages: defineLiveCollection\(\{ loader: apiPagesLoader\(\) \}\)/,
  );
  assert.throws(
    () =>
      assertApiPagesLiveCollection(
        "/site/app",
        ["big"],
        read,
        undefined,
        "app",
      ),
    /Create app\/live\.config\.ts/,
  );
  files.set("/site/src/live.config.ts", "export const collections = {};");
  assert.throws(
    () => assertApiPagesLiveCollection("/site/src", ["big"], read),
    /Register it in src\/live\.config\.ts/,
  );
  // The exported constant as the key is fine; a wrong key is reported on request.
  files.set(
    "/site/src/live.config.ts",
    'import { API_PAGES_COLLECTION, apiPagesLoader } from "@cloudflare/nimbus-docs/live";\nexport const collections = { [API_PAGES_COLLECTION]: defineLiveCollection({ loader: apiPagesLoader() }) };',
  );
  assert.doesNotThrow(() =>
    assertApiPagesLiveCollection("/site/src", ["big"], read),
  );
  // Astro reads live.config.mjs before .ts.
  files.set("/site/src/live.config.mjs", "export const collections = {};");
  assert.throws(
    () => assertApiPagesLiveCollection("/site/src", ["big"], read),
    /Register it in src\/live\.config\.mjs/,
  );
});

test("a symlinked source folder fails clearly instead of breaking Astro's live config", () => {
  assert.throws(
    () =>
      assertApiPagesLiveCollection(
        "/link/src",
        ["big"],
        () => "apiPagesLoader",
        () => "/real/src",
      ),
    /symlinked source folder \(\/link\/src → \/real\/src\)\. Build from the real path/,
  );
});

test("a trailing separator on the source folder isn't mistaken for a symlink", () => {
  assert.doesNotThrow(() =>
    assertApiPagesLiveCollection(
      "/site/src/",
      ["big"],
      () => "apiPagesLoader",
      (dir) => dir,
    ),
  );
});
