import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveMdxOptions } from "../src/integration.js";

test("MDX optimize is enabled by default", () => {
  assert.deepEqual(resolveMdxOptions(undefined), { optimize: true });
});

test("MDX optimize remains opt-out", () => {
  assert.deepEqual(resolveMdxOptions({ optimize: false }), { optimize: false });
});

test("native MDX options pass through", () => {
  assert.deepEqual(resolveMdxOptions({ gfm: false, smartypants: false }), {
    optimize: true,
    gfm: false,
    smartypants: false,
  });
});

for (const key of ["remarkPlugins", "rehypePlugins", "remarkRehype"]) {
  test(`unsupported ${key} fails with a native extension path`, () => {
    assert.throws(
      () =>
        resolveMdxOptions({ [key]: [] } as Parameters<
          typeof resolveMdxOptions
        >[0]),
      /Use markdown\.mdastPlugins or markdown\.hastPlugins with Sätteri instead/,
    );
  });
}
