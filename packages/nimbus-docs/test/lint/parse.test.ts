import assert from "node:assert/strict";
import { test } from "node:test";

import { collect, parseSource, startOf } from "../../src/lint/parse.js";

function parse(source: string) {
  return parseSource(source, {
    path: "fixture.mdx",
    absPath: "/abs/fixture.mdx",
    collection: null,
  });
}

test("frontmatter is parsed into an object", () => {
  const file = parse(`---
title: Test
description: A description.
---

# Title
`);
  assert.equal(file.frontmatter?.title, "Test");
  assert.equal(file.frontmatter?.description, "A description.");
  // Body starts on line 2 (after the opening fence on line 1).
  assert.equal(file.frontmatterStartLine, 2);
});

test("a file with no frontmatter reports null, not a crash", () => {
  const file = parse(`# Just a heading\n`);
  assert.equal(file.frontmatterRaw, null);
  assert.equal(file.frontmatter, null);
});

test("positions are character-based, not byte-based (multibyte safety)", () => {
  // "aé" is two characters but three UTF-8 bytes. The JSX element must
  // start at column 3 (character count), not 4 (byte count) — proving
  // positions come from the parser's unist Points, with no byte drift.
  const file = parse(`---
title: x
---

aé<Foo />
`);
  const jsx = collect(file.tree, "mdxJsxTextElement");
  assert.equal(jsx.length, 1);
  assert.equal(startOf(jsx[0]!).column, 3);
});

test("heading line numbers survive multibyte content", () => {
  const src = `---
title: x
---

# Héading →
`;
  const file = parse(src);
  const headings = collect(file.tree, "heading");
  assert.equal(headings.length, 1);
  assert.equal(startOf(headings[0]!).line, 5);
});
