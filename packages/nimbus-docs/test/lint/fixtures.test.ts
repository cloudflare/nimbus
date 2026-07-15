import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { findMdxFiles, lintPaths } from "../../src/lint/index.js";

const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

test("findMdxFiles discovers fixtures", () => {
  const files = findMdxFiles([fixturesDir]);
  assert.ok(files.some((f) => f.endsWith("clean.pass.mdx")));
  assert.ok(files.some((f) => f.endsWith("messy.fail.mdx")));
});

test("a *.pass.mdx fixture lints clean", () => {
  const file = path.join(fixturesDir, "clean.pass.mdx");
  const diags = lintPaths([file], projectRoot);
  assert.deepEqual(diags, []);
});

test("a *.fail.mdx fixture produces errors", () => {
  const file = path.join(fixturesDir, "messy.fail.mdx");
  // Authoring rules are opt-in; the fixture is designed to trip these four,
  // so we enable them here.
  const diags = lintPaths([file], projectRoot, {
    rules: {
      "nimbus/single-h1": "error",
      "nimbus/heading-hierarchy": "error",
      "nimbus/code-block-lang": "error",
      "nimbus/description-required": "error",
    },
  });
  const errors = diags.filter((d) => d.severity === "error");
  assert.ok(errors.length > 0, "expected at least one error");
  // It trips several distinct rules.
  const codes = new Set(diags.map((d) => d.code));
  assert.ok(codes.has("nimbus/single-h1"));
  assert.ok(codes.has("nimbus/heading-hierarchy"));
  assert.ok(codes.has("nimbus/code-block-lang"));
  assert.ok(codes.has("nimbus/description-required"));
});
