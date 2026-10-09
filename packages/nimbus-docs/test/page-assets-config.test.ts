import assert from "node:assert/strict";
import { test } from "node:test";
import { unbundledApiCollections } from "../src/_internal/page-assets-config.ts";
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
