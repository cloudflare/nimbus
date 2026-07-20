// Tests the pure corpus collation behind `renderCorpusMarkdown()` /
// `llms-full.txt`: deterministic ordering, `#`-level block shape, header
// cross-reference, and URL absolutization.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildCorpusMarkdown, type CorpusBlock } from "../src/_internal/corpus.ts";

const HEADER = {
  title: "Acme Docs",
  description: "Documentation for Acme.",
  site: "https://docs.acme.dev",
};

function block(overrides: Partial<CorpusBlock>): CorpusBlock {
  return {
    title: "Page",
    description: undefined,
    url: "/page/",
    markdownUrl: "/page/index.md",
    markdown: "## Section\n\nBody text.",
    ...overrides,
  };
}

describe("buildCorpusMarkdown", () => {
  test("sorts blocks by url regardless of input order", () => {
    const out = buildCorpusMarkdown(
      [
        block({ title: "Zulu", url: "/zulu/" }),
        block({ title: "Alpha", url: "/alpha/" }),
        block({ title: "Mid", url: "/mid/" }),
      ],
      HEADER,
    );
    const zulu = out.indexOf("# Zulu");
    const alpha = out.indexOf("# Alpha");
    const mid = out.indexOf("# Mid");
    assert.ok(alpha !== -1 && mid !== -1 && zulu !== -1);
    assert.ok(alpha < mid && mid < zulu);
  });

  test("is deterministic: same input set yields identical bytes", () => {
    const blocks = [
      block({ title: "B", url: "/b/" }),
      block({ title: "A", url: "/a/" }),
    ];
    const a = buildCorpusMarkdown(blocks, HEADER);
    const b = buildCorpusMarkdown([...blocks].reverse(), HEADER);
    assert.equal(a, b);
  });

  test("header opens with the site title and cross-references /llms.txt", () => {
    const out = buildCorpusMarkdown([], HEADER);
    assert.ok(out.startsWith("# Acme Docs\n"));
    assert.ok(out.includes("> Documentation for Acme."));
    assert.ok(out.includes("Index: https://docs.acme.dev/llms.txt"));
  });

  test("absolutizes URLs against site; stays relative without one", () => {
    const blocks = [block({ url: "/guide/", markdownUrl: "/guide/index.md" })];
    const abs = buildCorpusMarkdown(blocks, HEADER);
    assert.ok(
      abs.includes(
        "Source: https://docs.acme.dev/guide/ · Markdown: https://docs.acme.dev/guide/index.md",
      ),
    );
    const rel = buildCorpusMarkdown(blocks, { title: "Acme Docs" });
    assert.ok(rel.includes("Source: /guide/ · Markdown: /guide/index.md"));
    assert.ok(rel.includes("Index: /llms.txt"));
  });

  test("omits the description blockquote when absent — no empty lines", () => {
    const out = buildCorpusMarkdown(
      [block({ title: "NoDesc", description: undefined })],
      { title: "T" },
    );
    assert.ok(out.includes("# NoDesc\n\nSource: "));
    const withDesc = buildCorpusMarkdown(
      [block({ title: "HasDesc", description: "About this." })],
      { title: "T" },
    );
    assert.ok(withDesc.includes("# HasDesc\n\n> About this.\n\nSource: "));
  });

  test("every block appears exactly once", () => {
    const out = buildCorpusMarkdown(
      [
        block({ title: "One", url: "/one/" }),
        block({ title: "Two", url: "/two/" }),
      ],
      HEADER,
    );
    assert.equal(out.match(/^# One$/gm)?.length, 1);
    assert.equal(out.match(/^# Two$/gm)?.length, 1);
  });
});
