import assert from "node:assert/strict";
import { test } from "node:test";

import { applyFixes, lintFile, parseSource } from "../../src/lint/index.js";

function parse(source: string) {
  return parseSource(source, {
    path: "x.mdx",
    absPath: "/x.mdx",
    collection: null,
  });
}

const FM = `---
title: Test
description: A description.
---
`;

// Authoring rules are opt-in. These auto-fix tests exercise three of them at
// once; we opt them all in here rather than scattering rule names through
// the fixture sources.
const AUTOFIX_RULES = {
  "nimbus/heading-punctuation": "error",
  "nimbus/list-marker-style": "error",
  "nimbus/emphasis-style": "error",
} as const;

test("applyFixes resolves multiple fixable issues in one pass", () => {
  const src = `${FM}
## Title:

* one
* two

Some _em_ text.
`;
  const diags = lintFile(parse(src), { rules: AUTOFIX_RULES });
  const { output, fixed } = applyFixes(src, diags);

  assert.ok(fixed >= 4, `expected >= 4 fixes, got ${fixed}`);
  assert.ok(output.includes("## Title\n"), "trailing colon removed");
  assert.ok(output.includes("- one"), "first bullet normalized");
  assert.ok(output.includes("- two"), "second bullet normalized");
  assert.ok(output.includes("*em*"), "emphasis normalized");
  assert.ok(!output.includes("Title:"));
  assert.ok(!output.includes("_em_"));
});

test("applyFixes is idempotent — a fixed file has nothing left to fix", () => {
  const src = `${FM}
## Title:

* one
`;
  const first = applyFixes(src, lintFile(parse(src), { rules: AUTOFIX_RULES }));
  const second = applyFixes(
    first.output,
    lintFile(parse(first.output), { rules: AUTOFIX_RULES }),
  );
  assert.equal(second.fixed, 0);
  assert.equal(second.output, first.output);
});

test("applyFixes leaves un-fixable diagnostics untouched", () => {
  // description-required has no auto-fix; the file should be unchanged.
  const src = `---
title: No Description
---

# Title
`;
  const { output, fixed } = applyFixes(src, lintFile(parse(src)));
  assert.equal(fixed, 0);
  assert.equal(output, src);
});

test("applyFixes.applied set excludes advisory-only fixes (empty edits)", () => {
  // Some rules carry a `fix.description` for messaging but no `edits` —
  // the did-you-mean hint on `internal-link` is the canonical case. They
  // must NOT be marked as applied, or the caller will hide the diagnostic
  // from the post-fix report while the file is still broken.
  const advisoryOnly = [
    {
      code: "nimbus/internal-link" as const,
      severity: "error" as const,
      source: "docs-compiler" as const,
      file: "x.mdx",
      message: "broken link",
      line: 1,
      column: 1,
      fix: { description: "did you mean /foo?", edits: [] },
    },
  ];
  const result = applyFixes("hello", advisoryOnly);
  assert.equal(result.fixed, 0);
  assert.equal(result.applied.size, 0);
  assert.equal(result.output, "hello");
});
