import assert from "node:assert/strict";
import { test } from "node:test";

import { lintFile, parseSource } from "../../src/lint/index.js";

/**
 * Structural conformance to `src/lint/diagnostic.schema.json`. A full
 * JSON-schema validator would mean an extra dependency; this asserts the
 * same shape constraints (required keys, enums, types, code pattern) the
 * schema declares. If the envelope changes, this test and the schema move
 * together.
 */
test("diagnostics conform to the committed JSON schema shape", () => {
  const src = `---
title: Test
---

#### Skips levels

\`\`\`
no lang
\`\`\`

# A second top heading
`;
  const file = parseSource(src, {
    path: "x.mdx",
    absPath: "/x.mdx",
    collection: null,
  });
  // Authoring rules are opt-in. Enable the ones this fixture is designed
  // to trip so the schema check has diagnostics to validate against.
  const diagnostics = lintFile(file, {
    rules: {
      "nimbus/heading-hierarchy": "error",
      "nimbus/single-h1": "error",
      "nimbus/code-block-lang": "error",
      "nimbus/description-required": "error",
    },
  });
  assert.ok(diagnostics.length > 0);

  const allowed = new Set([
    "code",
    "severity",
    "source",
    "message",
    "file",
    "line",
    "column",
    "endLine",
    "endColumn",
    "fix",
  ]);

  for (const d of diagnostics) {
    for (const key of Object.keys(d)) {
      assert.ok(allowed.has(key), `unexpected key on diagnostic: ${key}`);
    }
    assert.match(d.code, /^nimbus\//);
    assert.ok(d.severity === "error" || d.severity === "warn");
    assert.equal(d.source, "docs-compiler");
    assert.equal(typeof d.message, "string");
    assert.equal(typeof d.file, "string");
    assert.ok(Number.isInteger(d.line) && d.line >= 1);
    assert.ok(Number.isInteger(d.column) && d.column >= 1);
  }
});
