import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolvePrerenderChunkNames,
  PRERENDER_ENTRY_FILE_NAME,
  PRERENDER_CHUNK_FILE_NAME,
} from "../src/_internal/prerender-chunk-names.js";

const BOTH = {
  entryFileNames: PRERENDER_ENTRY_FILE_NAME,
  chunkFileNames: PRERENDER_CHUNK_FILE_NAME,
};

test("defaults hashless names when nothing is configured", () => {
  assert.deepEqual(resolvePrerenderChunkNames({}), BOTH);
});

test("defaults hashless names when the whole vite config is undefined", () => {
  assert.deepEqual(resolvePrerenderChunkNames(undefined), BOTH);
});

test("ignores top-level output — Astro never inherits it into the prerender bundle", () => {
  // A top-level output config is irrelevant to the prerender env, so it must not
  // suppress the optimization.
  const out = resolvePrerenderChunkNames({
    // @ts-expect-error - top-level build is intentionally not part of the input type
    build: { rolldownOptions: { output: { entryFileNames: "top-[hash].js" } } },
  });
  assert.deepEqual(out, BOTH);
});

test("bails when the consumer configured the prerender env via rolldownOptions", () => {
  const out = resolvePrerenderChunkNames({
    environments: {
      prerender: { build: { rolldownOptions: { output: { entryFileNames: "e.mjs" } } } },
    },
  });
  assert.equal(out, null);
});

test("bails when the consumer configured the prerender env via the rollupOptions alias", () => {
  // The M1 case: writing our native rolldownOptions here would make Vite drop
  // the consumer's rollupOptions. Staying out entirely is the only safe move.
  const out = resolvePrerenderChunkNames({
    environments: {
      prerender: { build: { rollupOptions: { output: { entryFileNames: "keep-[hash].mjs" } } } },
    },
  });
  assert.equal(out, null);
});

test("bails on a prerender-env output array", () => {
  const out = resolvePrerenderChunkNames({
    environments: { prerender: { build: { rolldownOptions: { output: [{}] } } } },
  });
  assert.equal(out, null);
});

test("bails on an empty-but-present prerender-env output object", () => {
  const out = resolvePrerenderChunkNames({
    environments: { prerender: { build: { rollupOptions: { output: {} } } } },
  });
  assert.equal(out, null);
});
