// The eight rules that once ran through remark-lint must report exactly what
// they reported then: every diagnostic in full (code, message, severity,
// position, fix) and the text after applying the fixes, under each Markdown
// feature setting a site can use. `native-parity.snapshot.json` was captured
// from the remark-lint-backed rules; regenerate it only on purpose, with
// NIMBUS_UPDATE_PARITY=1.

import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";

import type { Features } from "satteri";

import { markdownFeatures, setMarkdownFeatures } from "../../src/_internal/markdown-features.js";
import { applyFixes } from "../../src/lint/fix.js";
import { lintFile, parseSource } from "../../src/lint/index.js";
import type { RuleCode } from "../../src/lint/index.js";

const SNAPSHOT = new URL("./native-parity.snapshot.json", import.meta.url);
const FM = "---\ntitle: Test\ndescription: A description.\n---\n";

const GFM_OFF: Features = { gfm: false, smartPunctuation: true };
const HEADINGS: Features = { gfm: true, smartPunctuation: true, headingAttributes: true, math: true };
const FEATURES: Record<string, Features | undefined> = { default: undefined, gfmOff: GFM_OFF, headings: HEADINGS };

interface Case {
  rule: RuleCode;
  name: string;
  source: string;
  options?: Record<string, unknown>;
  mdx?: boolean;
}

const cases: Case[] = [
  // single-h1
  { rule: "nimbus/single-h1", name: "none", source: "## A\n\n## B\n" },
  { rule: "nimbus/single-h1", name: "one", source: "# A\n\n## B\n" },
  { rule: "nimbus/single-h1", name: "three", source: "# A\n\n# B\n\ntext\n\n# C\n" },
  { rule: "nimbus/single-h1", name: "setext", source: "A\n===\n\nB\n===\n" },
  { rule: "nimbus/single-h1", name: "html h1", source: "# A\n\n<h1>B</h1>\n" },
  { rule: "nimbus/single-h1", name: "jsx h1", source: "# A\n\n<h1>B</h1>\n", mdx: true },
  { rule: "nimbus/single-h1", name: "nested", source: "# A\n\n> # B\n\n- # C\n" },
  // heading-hierarchy
  { rule: "nimbus/heading-hierarchy", name: "ok", source: "# A\n\n## B\n\n### C\n\n## D\n" },
  { rule: "nimbus/heading-hierarchy", name: "skip", source: "## A\n\n#### B\n\n##### C\n\n## D\n\n#### E\n" },
  { rule: "nimbus/heading-hierarchy", name: "first deep", source: "### A\n\n##### B\n" },
  { rule: "nimbus/heading-hierarchy", name: "html between", source: "## A\n\n<h3>B</h3>\n\n##### C\n" },
  { rule: "nimbus/heading-hierarchy", name: "jsx", source: "## A\n\n<h4>B</h4>\n\n### C\n", mdx: true },
  { rule: "nimbus/heading-hierarchy", name: "attributes", source: "## A {#a}\n\n#### B {#b}\n" },
  // code-block-lang
  { rule: "nimbus/code-block-lang", name: "kinds", source: "```\nx\n```\n\n```ts\ny\n```\n\n~~~\nz\n~~~\n\n    indented\n\n   ```\n   spaced\n   ```\n" },
  { rule: "nimbus/code-block-lang", name: "nested", source: "- item\n\n  ```\n  in list\n  ```\n\n> ```\n> in quote\n> ```\n" },
  { rule: "nimbus/code-block-lang", name: "empty and long", source: "````\n````\n\n``` \nmeta-less\n```\n" },
  { rule: "nimbus/code-block-lang", name: "options", source: "```\nx\n```\n\n```zz\ny\n```\n", options: { allow: ["ts"] } },
  // heading-punctuation
  { rule: "nimbus/heading-punctuation", name: "endings", source: "## Colon:\n\n## Period.\n\n## Bang!\n\n## Question?\n\n## Both,;\n\n## Fine\n" },
  { rule: "nimbus/heading-punctuation", name: "inline tail", source: "## Use `x`.\n\n## A *word*:\n\n## [Link](https://example.com).\n\n## **Bold**!\n" },
  { rule: "nimbus/heading-punctuation", name: "attributes", source: "## Title: {#title}\n\n## Fine {#fine}\n" },
  { rule: "nimbus/heading-punctuation", name: "jsx", source: "<h2>Title:</h2>\n\n## Ok\n", mdx: true },
  { rule: "nimbus/heading-punctuation", name: "setext", source: "Title.\n------\n" },
  // duplicate-heading-text
  { rule: "nimbus/duplicate-heading-text", name: "dupes", source: "## Setup\n\n## Usage\n\n### setup\n\n## Setup\n" },
  { rule: "nimbus/duplicate-heading-text", name: "spacing", source: "## Setup \n\n## Setup\n\n## Set  up\n" },
  { rule: "nimbus/duplicate-heading-text", name: "inline", source: "## Use `x`\n\n## Use x\n\n## *Use* x\n" },
  { rule: "nimbus/duplicate-heading-text", name: "jsx", source: "## Notes\n\n<h2>Notes</h2>\n", mdx: true },
  { rule: "nimbus/duplicate-heading-text", name: "empty", source: "##\n\n##\n" },
  // list-marker-style
  { rule: "nimbus/list-marker-style", name: "mixed", source: "- a\n- b\n\n* c\n* d\n\n+ e\n" },
  { rule: "nimbus/list-marker-style", name: "asterisk", source: "- a\n\n* b\n", options: { style: "asterisk" } },
  { rule: "nimbus/list-marker-style", name: "nested", source: "- a\n  * b\n    + c\n\n1. one\n2. two\n\n> * quoted\n" },
  { rule: "nimbus/list-marker-style", name: "task", source: "* [ ] todo\n* [x] done\n" },
  // emphasis-style
  { rule: "nimbus/emphasis-style", name: "default", source: "Some _a_ and *b* and __c__ and **d**.\n" },
  { rule: "nimbus/emphasis-style", name: "underscore", source: "Some _a_ and *b*.\n", options: { style: "underscore" } },
  { rule: "nimbus/emphasis-style", name: "nested", source: "**bold _in_ bold** and _outer *inner* outer_\n\n## A _heading_\n" },
  { rule: "nimbus/emphasis-style", name: "intraword", source: "snake_case_word and in*side*word\n" },
  // bare-url
  { rule: "nimbus/bare-url", name: "kinds", source: "See https://example.com and www.example.com and [docs](https://example.net).\n\nhttp://example.org/path?q=1 at the start.\n" },
  { rule: "nimbus/bare-url", name: "mailto", source: "Write to someone@example.com or mailto:other@example.com.\n" },
  { rule: "nimbus/bare-url", name: "in code and headings", source: "## See https://example.com\n\n`https://example.com` and\n\n```txt\nhttps://example.com\n```\n\n- www.example.com\n" },
  { rule: "nimbus/bare-url", name: "link text is url", source: "[https://example.com](https://example.com) and [example.com](http://example.com)\n" },
];

function run(c: Case, features: Features | undefined) {
  const previous = markdownFeatures();
  if (features) setMarkdownFeatures(features);
  try {
    const source = `${FM}\n${c.source}`;
    const file = parseSource(source, { path: c.mdx ? "x.mdx" : "x.md", absPath: c.mdx ? "/x.mdx" : "/x.md", collection: null });
    const diagnostics = lintFile(file, { only: c.rule, rules: c.options ? { [c.rule]: ["error", c.options] } : {} });
    return { diagnostics, fixed: applyFixes(source, diagnostics).output };
  } finally {
    setMarkdownFeatures(previous);
  }
}

const results: Record<string, unknown> = {};
for (const c of cases) {
  for (const [label, features] of Object.entries(FEATURES)) {
    results[`${c.rule} | ${c.name} | ${c.mdx ? "mdx" : "md"} | ${label}`] = JSON.parse(JSON.stringify(run(c, features)));
  }
}

if (process.env.NIMBUS_UPDATE_PARITY === "1") {
  after(() => fs.writeFileSync(SNAPSHOT, `${JSON.stringify(results, null, 2)}\n`));
  test("parity snapshot regenerated", () => {});
} else {
  const expected = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")) as Record<string, unknown>;
  test("the snapshot covers every case", () => {
    assert.deepEqual(Object.keys(results).sort(), Object.keys(expected).sort());
  });
  for (const [key, value] of Object.entries(results)) {
    test(key, () => assert.deepEqual(value, expected[key]));
  }
}
